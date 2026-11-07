import { TransientPersistenceError } from '../../application/ports/wager-unit-of-work';
import type { ProcessWagerTransactionResult } from '../../application/wagering/process-wager-transaction';
import {
  kindLabel,
  type InstrumentedProcessWagerTransaction,
} from '../../infrastructure/observability/instrumented-process-wager-transaction';
import { rootLogger } from '../../infrastructure/observability/logger';
import type { ObservabilityMetrics } from '../../infrastructure/observability/metrics';
import type { InboxLookup } from '../../infrastructure/sqs/inbox-lookup';
import type { DlqReason, ReceivedMessage, WagerQueueClient } from '../../infrastructure/sqs/wager-queue.client';
import { parseEnvelope, type WagerEnvelope } from './wager-envelope';

export interface WagerConsumerOptions {
  consumerName: string;
  maxMessages: number;
  waitTimeSeconds: number;
  visibilityTimeoutSeconds: number;
  retryBaseSeconds: number;
  retryMaxSeconds: number;
  shutdownTimeoutMs: number;
}

/** Pausa do polling quando o banco (ou o SQS) está fora: 1s·2^(n−1), até 30s. */
export const POLL_PAUSE_BASE_MS = 1_000;
export const POLL_PAUSE_MAX_MS = 30_000;

type Decision =
  | { action: 'ack'; outcome: string; transactionId?: string; warn?: boolean }
  | { action: 'retry'; reason: string; unavailable: boolean }
  | { action: 'dlq'; reason: DlqReason; detail: string };

type LogContext = Record<string, unknown>;

/** Atraso da nova tentativa: base·2^(receiveCount−1), com teto. */
export function retryDelaySeconds(receiveCount: number, baseSeconds: number, maxSeconds: number): number {
  const exponent = Math.min(Math.max(receiveCount - 1, 0), 30);
  return Math.min(maxSeconds, baseSeconds * 2 ** exponent);
}

export function pollPauseMs(consecutiveFailures: number): number {
  const exponent = Math.min(Math.max(consecutiveFailures - 1, 0), 30);
  return Math.min(POLL_PAUSE_MAX_MS, POLL_PAUSE_BASE_MS * 2 ** exponent);
}

/**
 * Consumidor de `wager-transactions.fifo`. Reutiliza o use case da entrada HTTP (via o
 * wrapper instrumentado) com contexto de inbox. Ack só depois que o use case retorna (commit);
 * classificação e números no ARCHITECTURE.md §18.
 */
export class WagerConsumer {
  private readonly logger = rootLogger.child({ name: 'WagerConsumer' });
  private running = false;
  private loop: Promise<void> | undefined;
  /** Recebidas e ainda sem decisão aplicada (inclui as que esperam a vez no grupo). */
  private readonly unfinished = new Set<ReceivedMessage>();
  private wakeUp: (() => void) | undefined;

  constructor(
    private readonly queue: Pick<WagerQueueClient, 'maxReceiveCount' | 'receive' | 'delete' | 'changeVisibility' | 'sendToDlq'>,
    private readonly inbox: Pick<InboxLookup, 'payloadHashOf'>,
    private readonly process: Pick<InstrumentedProcessWagerTransaction, 'execute'>,
    private readonly metrics: ObservabilityMetrics,
    private readonly options: WagerConsumerOptions,
  ) {}

  start(): void {
    if (this.loop) return;
    this.running = true;
    this.logger.info({ event: 'sqs_consumer_started', consumerName: this.options.consumerName }, 'sqs consumer started');
    this.loop = this.run();
  }

  /**
   * Para de buscar, espera as mensagens em andamento até `shutdownTimeoutMs` e devolve a
   * visibilidade (0) das que não terminaram. O que já commitou e não teve ack é resolvido
   * pela inbox na reentrega.
   */
  async stop(): Promise<void> {
    if (!this.loop) return;
    this.running = false;
    this.wakeUp?.();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finished = await Promise.race([
      this.loop.then(() => true),
      new Promise<boolean>((resolve) => {
        timer = setTimeout(() => resolve(false), this.options.shutdownTimeoutMs);
      }),
    ]);
    clearTimeout(timer);
    if (!finished) {
      this.logger.warn({ event: 'sqs_consumer_shutdown_timeout', pending: this.unfinished.size }, 'shutdown timeout');
      await this.releaseAll();
    }
    this.loop = undefined;
    this.logger.info({ event: 'sqs_consumer_stopped', consumerName: this.options.consumerName }, 'sqs consumer stopped');
  }

  private async run(): Promise<void> {
    let failures = 0;
    while (this.running) {
      let unavailable: boolean;
      try {
        const maxReceiveCount = await this.queue.maxReceiveCount();
        const messages = await this.queue.receive({
          maxMessages: this.options.maxMessages,
          waitTimeSeconds: this.options.waitTimeSeconds,
          visibilityTimeoutSeconds: this.options.visibilityTimeoutSeconds,
        });
        for (const message of messages) this.unfinished.add(message);
        unavailable = await this.processBatch(messages, maxReceiveCount);
      } catch (error) {
        this.logger.error({ event: 'sqs_poll_failed', errorName: errorName(error) }, 'sqs poll failed');
        unavailable = true;
      }
      if (!unavailable) {
        failures = 0;
        continue;
      }
      failures++;
      const pauseMs = pollPauseMs(failures);
      this.logger.warn({ event: 'sqs_polling_paused', pauseMs, failures }, 'polling paused');
      await this.pause(pauseMs);
    }
  }

  /**
   * Grupos FIFO diferentes em paralelo; o mesmo grupo em sequência. Se uma mensagem do grupo
   * vai para retry, as seguintes voltam para a fila (visibilidade 0) e esperam atrás dela.
   * Devolve true se alguma falha indicou banco indisponível (o loop pausa o polling).
   */
  private async processBatch(messages: readonly ReceivedMessage[], maxReceiveCount: number): Promise<boolean> {
    const groups = new Map<string, ReceivedMessage[]>();
    for (const message of messages) {
      const key = message.groupId ?? message.sqsMessageId;
      groups.set(key, [...(groups.get(key) ?? []), message]);
    }
    const results = await Promise.all([...groups.values()].map((group) => this.processGroup(group, maxReceiveCount)));
    return results.some(Boolean);
  }

  private async processGroup(group: readonly ReceivedMessage[], maxReceiveCount: number): Promise<boolean> {
    for (const [index, message] of group.entries()) {
      if (!this.running) {
        await this.release(group.slice(index));
        return false;
      }
      const decision = await this.handle(message, maxReceiveCount);
      if (decision?.action === 'retry') {
        await this.release(group.slice(index + 1));
        return decision.unavailable;
      }
    }
    return false;
  }

  private async handle(message: ReceivedMessage, maxReceiveCount: number): Promise<Decision | undefined> {
    const context: LogContext = { sqsMessageId: message.sqsMessageId, receiveCount: message.receiveCount };
    try {
      const decision = await this.decide(message, context);
      await this.apply(decision, message, maxReceiveCount, context);
      return decision;
    } catch (error) {
      // Falha ao falar com o SQS: a mensagem volta sozinha quando a visibilidade expirar.
      this.logger.error({ ...context, event: 'sqs_message_action_failed', errorName: errorName(error) }, 'sqs action failed');
      return undefined;
    } finally {
      this.unfinished.delete(message);
    }
  }

  private async decide(message: ReceivedMessage, context: LogContext): Promise<Decision> {
    const envelope = parseEnvelope(message.body);
    if (typeof envelope === 'string') return { action: 'dlq', reason: 'INVALID_ENVELOPE', detail: envelope };
    context.messageId = envelope.messageId;
    context.correlationId = envelope.correlationId;

    try {
      const stored = await this.inbox.payloadHashOf(this.options.consumerName, envelope.messageId);
      if (stored !== undefined) return this.fromInbox(stored, envelope);

      const result = await this.process.execute({
        idempotencyKey: envelope.idempotencyKey,
        payload: envelope.data,
        correlationId: envelope.correlationId,
        inbox: { consumerName: this.options.consumerName, messageId: envelope.messageId, payloadHash: envelope.payloadHash },
      });
      return await this.fromResult(result, envelope);
    } catch (error) {
      // Transitório do banco, ou erro inesperado (bug): retry até o limite de tentativas.
      if (error instanceof TransientPersistenceError) {
        return { action: 'retry', reason: error.reason, unavailable: error.reason === 'unavailable' };
      }
      this.logger.error({ ...context, event: 'sqs_message_unexpected_error', errorName: errorName(error) }, 'unexpected error');
      return { action: 'retry', reason: 'unexpected_error', unavailable: false };
    }
  }

  /** A inbox já tem a mensagem: mesmo hash é reentrega (ack); hash diferente é erro permanente. */
  private fromInbox(storedHash: string, envelope: WagerEnvelope): Decision {
    if (storedHash !== envelope.payloadHash) {
      return { action: 'dlq', reason: 'INBOX_PAYLOAD_MISMATCH', detail: 'messageId já processado com outro payload' };
    }
    this.metrics.replays.inc({ kind: kindLabel(envelope.data.kind) });
    return { action: 'ack', outcome: 'DUPLICATE_MESSAGE' };
  }

  private async fromResult(result: ProcessWagerTransactionResult, envelope: WagerEnvelope): Promise<Decision> {
    switch (result.type) {
      case 'Processed':
      case 'Rejected':
      case 'PendingReference':
        return { action: 'ack', outcome: result.status, transactionId: result.transactionId };
      case 'IdempotencyConflict': {
        if (result.existingTransactionId !== undefined) {
          // Conflito de negócio (mesma key, outro payload): terminal. A métrica vem do wrapper.
          return { action: 'ack', outcome: 'IDEMPOTENCY_CONFLICT', transactionId: result.existingTransactionId, warn: true };
        }
        // Conflito na inbox: outra instância gravou a mesma mensagem. Relê para decidir.
        const stored = await this.inbox.payloadHashOf(this.options.consumerName, envelope.messageId);
        if (stored === undefined) return { action: 'retry', reason: 'inbox_conflict_unresolved', unavailable: false };
        return this.fromInbox(stored, envelope);
      }
      case 'InvalidInput':
        return { action: 'dlq', reason: 'INVALID_PAYLOAD', detail: result.reason };
      case 'TransientFailure':
        return { action: 'retry', reason: result.reason, unavailable: result.reason === 'unavailable' };
    }
  }

  private async apply(decision: Decision, message: ReceivedMessage, maxReceiveCount: number, context: LogContext): Promise<void> {
    switch (decision.action) {
      case 'ack': {
        const fields = {
          ...context,
          event: 'sqs_message_acked',
          outcome: decision.outcome,
          ...(decision.transactionId ? { transactionId: decision.transactionId } : {}),
        };
        if (decision.warn) this.logger.warn(fields, 'sqs message acked with conflict');
        else this.logger.info(fields, 'sqs message acked');
        try {
          await this.queue.delete(message);
        } catch (error) {
          // O efeito já foi commitado: a reentrega cai na inbox e é confirmada sem efeito novo.
          this.logger.warn({ ...context, event: 'sqs_ack_failed', errorName: errorName(error) }, 'sqs ack failed');
        }
        return;
      }
      case 'retry': {
        if (message.receiveCount >= maxReceiveCount) {
          return this.apply({ action: 'dlq', reason: 'MAX_ATTEMPTS_EXCEEDED', detail: decision.reason }, message, maxReceiveCount, context);
        }
        const delaySeconds = retryDelaySeconds(message.receiveCount, this.options.retryBaseSeconds, this.options.retryMaxSeconds);
        await this.queue.changeVisibility(message, delaySeconds);
        this.metrics.retries.inc();
        this.logger.warn({ ...context, event: 'sqs_message_retry', reason: decision.reason, delaySeconds }, 'sqs message retry');
        return;
      }
      case 'dlq': {
        // Primeiro a DLQ, depois o delete: se cair no meio, a mensagem volta e o envio é deduplicado.
        await this.queue.sendToDlq(message, decision.reason, decision.detail);
        await this.queue.delete(message);
        this.metrics.dlqMessages.inc();
        this.logger.warn({ ...context, event: 'sqs_message_dead_lettered', reason: decision.reason }, 'sqs message sent to dlq');
        return;
      }
    }
  }

  private async release(messages: readonly ReceivedMessage[]): Promise<void> {
    await Promise.all(
      messages.map(async (message) => {
        try {
          await this.queue.changeVisibility(message, 0);
        } catch (error) {
          this.logger.warn(
            { sqsMessageId: message.sqsMessageId, event: 'sqs_release_failed', errorName: errorName(error) },
            'sqs release failed',
          );
        } finally {
          this.unfinished.delete(message);
        }
      }),
    );
  }

  private async releaseAll(): Promise<void> {
    await this.release([...this.unfinished]);
  }

  private pause(ms: number): Promise<void> {
    if (!this.running) return Promise.resolve();
    return new Promise((resolve) => {
      const done = (): void => {
        clearTimeout(timer);
        this.wakeUp = undefined;
        resolve();
      };
      const timer = setTimeout(done, ms);
      this.wakeUp = done;
    });
  }
}

function errorName(error: unknown): string {
  return error instanceof Error ? error.name : typeof error;
}
