import type { Logger } from 'pino';
import type { Clock } from '../../application/ports/clock';
import type { OutboxMessage } from '../../domain/outbox-message';
import { rootLogger } from '../../infrastructure/observability/logger';
import type { ObservabilityMetrics } from '../../infrastructure/observability/metrics';
import type { OutboxEventsClient, PublishResult } from '../../infrastructure/outbox/outbox-events.client';
import type { OutboxStore } from '../../infrastructure/outbox/outbox-store';

export interface OutboxPublisherOptions {
  batchSize: number;
  pollIntervalMs: number;
  sqsTimeoutMs: number;
  stuckAttempts: number;
  shutdownTimeoutMs: number;
}

/** Pausa quando o próprio ciclo falha (banco fora): 1s·2^(n−1), até 30s. */
export const ERROR_PAUSE_BASE_MS = 1_000;
export const ERROR_PAUSE_MAX_MS = 30_000;

export function errorPauseMs(consecutiveFailures: number): number {
  const exponent = Math.min(Math.max(consecutiveFailures - 1, 0), 30);
  return Math.min(ERROR_PAUSE_MAX_MS, ERROR_PAUSE_BASE_MS * 2 ** exponent);
}

/**
 * Publica a outbox em `wager-events.fifo`. Cada ciclo: claim com `FOR UPDATE SKIP LOCKED`,
 * `SendMessageBatch` ainda com o lock, e published_at / retry gravados no mesmo commit.
 * Seguro com N instâncias; entrega at-least-once (o consumidor deduplica por eventId).
 * Decisões no ARCHITECTURE.md §19.
 */
export class OutboxPublisher {
  private running = false;
  private loop: Promise<void> | undefined;
  private wakeUp: (() => void) | undefined;
  private lastBacklogAt = 0;

  constructor(
    private readonly store: Pick<OutboxStore, 'claim' | 'backlog'>,
    private readonly events: Pick<OutboxEventsClient, 'publish'>,
    private readonly clock: Clock,
    private readonly metrics: ObservabilityMetrics,
    private readonly options: OutboxPublisherOptions,
    private readonly logger: Logger = rootLogger.child({ name: 'OutboxPublisher' }),
  ) {}

  start(): void {
    if (this.loop) {
      this.logger.warn({ event: 'outbox_publisher_already_running' }, 'outbox publisher loop still running');
      return;
    }
    this.running = true;
    this.logger.info({ event: 'outbox_publisher_started' }, 'outbox publisher started');
    this.loop = this.run().finally(() => {
      this.loop = undefined;
    });
  }

  /**
   * Para de buscar e espera o lote em andamento commitar, até `shutdownTimeoutMs`. Um lote
   * abandonado é desfeito quando o ORM fecha (rollback): outro publisher o republica.
   */
  async stop(): Promise<void> {
    const loop = this.loop;
    if (!loop) return;
    this.running = false;
    this.wakeUp?.();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finished = await Promise.race([
      loop.then(() => true),
      new Promise<boolean>((resolve) => {
        timer = setTimeout(() => resolve(false), this.options.shutdownTimeoutMs);
      }),
    ]);
    clearTimeout(timer);
    if (!finished) this.logger.warn({ event: 'outbox_publisher_shutdown_timeout' }, 'shutdown timeout');
    this.logger.info({ event: 'outbox_publisher_stopped' }, 'outbox publisher stopped');
  }

  /** Um ciclo: claim → publicação → commit. Devolve quantos eventos foram tratados. Exposto para testes. */
  async publishOnce(): Promise<number> {
    let outcome: PublishResult | undefined;
    const messages = await this.store.claim(this.options.batchSize, this.clock.now(), async (claimed) => {
      outcome = await this.publish(claimed);
      const at = this.clock.now();
      for (const message of claimed) {
        if (outcome?.published.has(message.id)) message.markPublished(at);
        else message.scheduleRetry(at);
      }
    });
    // Só depois do commit: métricas e logs refletem o que ficou gravado.
    for (const message of messages) {
      if (!message.isPending()) continue;
      this.metrics.outboxRetries.inc();
      if (message.attempts >= this.options.stuckAttempts) this.logStuck(message, outcome);
    }
    const published = messages.filter((message) => !message.isPending()).length;
    if (published > 0) this.metrics.outboxPublished.inc(published);
    return messages.length;
  }

  private async run(): Promise<void> {
    let failures = 0;
    while (this.running) {
      let handled: number;
      try {
        handled = await this.publishOnce();
        failures = 0;
      } catch (error) {
        failures++;
        const pauseMs = errorPauseMs(failures);
        this.logger.error({ event: 'outbox_cycle_failed', errorName: errorName(error), pauseMs }, 'outbox cycle failed');
        await this.pause(pauseMs);
        continue;
      }
      await this.measureBacklog(handled === 0);
      // Publicou ou reagendou algo: busca de novo na hora. Só espera quando o claim volta vazio.
      if (handled === 0) await this.pause(this.options.pollIntervalMs);
    }
  }

  /**
   * A chamada inteira falhou (rede, timeout): todos do lote vão para retry. Por entrada: só os
   * recusados. Se a chamada inteira foi recusada por erro do cliente (4xx), uma entrada pode ser a
   * causa: reenvia uma a uma, para não prender os outros agregados do lote junto com ela.
   * Um único prazo (`sqsTimeoutMs`) vale para tudo, abaixo do idle timeout da transação.
   */
  private async publish(messages: readonly OutboxMessage[]): Promise<PublishResult | undefined> {
    const signal = AbortSignal.timeout(this.options.sqsTimeoutMs);
    let result: PublishResult;
    try {
      result = await this.events.publish(messages, signal);
    } catch (error) {
      this.metrics.outboxPublishFailures.inc({ scope: 'batch' });
      const isolate = messages.length > 1 && isClientFault(error) && !signal.aborted;
      this.logger.warn(
        { event: 'outbox_publish_failed', errorName: errorName(error), batch: messages.length, isolate },
        'outbox publish failed',
      );
      if (!isolate) return undefined;
      result = await this.publishOneByOne(messages, signal);
    }
    if (result.failed.size > 0) {
      this.metrics.outboxPublishFailures.inc({ scope: 'entry' }, result.failed.size);
      for (const [eventId, code] of result.failed) {
        this.logger.warn({ event: 'outbox_entry_failed', eventId, code }, 'outbox entry rejected by broker');
      }
    }
    return result;
  }

  private async publishOneByOne(messages: readonly OutboxMessage[], signal: AbortSignal): Promise<PublishResult> {
    const published = new Set<string>();
    const failed = new Map<string, string>();
    for (const message of messages) {
      try {
        const single = await this.events.publish([message], signal);
        for (const id of single.published) published.add(id);
        for (const [id, code] of single.failed) failed.set(id, code);
      } catch (error) {
        failed.set(message.id, errorName(error));
      }
    }
    return { published, failed };
  }

  /** Lag e travados: a cada ciclo vazio, ou no máximo uma vez por intervalo sob carga. */
  private async measureBacklog(idle: boolean): Promise<void> {
    const nowMs = Date.now();
    if (!idle && nowMs - this.lastBacklogAt < this.options.pollIntervalMs) return;
    this.lastBacklogAt = nowMs;
    try {
      const { lagSeconds, stuck } = await this.store.backlog(this.clock.now(), this.options.stuckAttempts);
      this.metrics.outboxLag.set(lagSeconds);
      this.metrics.outboxStuck.set(stuck);
    } catch (error) {
      this.logger.warn({ event: 'outbox_backlog_failed', errorName: errorName(error) }, 'outbox backlog failed');
    }
  }

  private logStuck(message: OutboxMessage, outcome: PublishResult | undefined): void {
    this.logger.error(
      {
        event: 'outbox_event_stuck',
        eventId: message.id,
        aggregateId: message.aggregateId,
        eventType: message.eventType,
        attempts: message.attempts,
        nextAttemptAt: message.nextAttemptAt?.toISOString(),
        code: outcome?.failed.get(message.id) ?? 'batch_failed',
      },
      'outbox event stuck: blocks later events of the same aggregate',
    );
  }

  private pause(ms: number): Promise<void> {
    if (!this.running) return Promise.resolve();
    return new Promise((resolve) => {
      const timer = setTimeout(done, ms);
      function done(): void {
        clearTimeout(timer);
        resolve();
      }
      this.wakeUp = () => {
        this.wakeUp = undefined;
        done();
      };
    });
  }
}

/** Erro do AWS SDK atribuído ao chamador (4xx): `$fault === 'client'`. */
function isClientFault(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { $fault?: unknown }).$fault === 'client';
}

function errorName(error: unknown): string {
  return error instanceof Error ? error.name : typeof error;
}
