import type { Logger } from 'pino';
import type { PendingReferenceCandidate } from '../../application/ports/wager-unit-of-work';
import type {
  PendingReferenceOutcome,
  ResolvePendingReferences,
} from '../../application/wagering/resolve-pending-references';
import { rootLogger } from '../../infrastructure/observability/logger';
import type { ObservabilityMetrics } from '../../infrastructure/observability/metrics';
import { errorPauseMs } from './outbox-publisher';

export interface PendingReferenceWorkerOptions {
  batchSize: number;
  pollIntervalMs: number;
  gaugeIntervalMs: number;
  shutdownTimeoutMs: number;
}

/** Erros inesperados seguidos da mesma candidata (nesta instância) antes de encerrá-la como FAILED. */
export const MAX_CONSECUTIVE_ERRORS = 5;
/** `wallet_busy` seguidos da mesma candidata antes de esperar o lock da wallet (com lock_timeout). */
export const MAX_CONSECUTIVE_BUSY = 5;
/** Teto de entradas dos contadores em memória (ids que outra instância resolveu não voltam). */
const MAX_TRACKED = 10_000;

/**
 * Worker agendado das PENDING_REFERENCE (CHALLENGE §7.1). Cada ciclo busca candidatas vencidas
 * sem lock e trata uma por vez, cada uma na sua transação (`ResolvePendingReferences.resolve`).
 * No shutdown para entre candidatas: a transação em andamento termina. Decisões no ARCHITECTURE.md → "Worker de referências pendentes".
 */
export class PendingReferenceWorker {
  private running = false;
  private loop: Promise<void> | undefined;
  private wakeUp: (() => void) | undefined;
  private lastGaugeAt = 0;
  /**
   * Heurística operacional, por instância e em memória (zera no restart; cada instância conta a
   * sua parte). Não é garantia: a correção vem do lock e da releitura no banco. ARCHITECTURE.md → "Worker de referências pendentes".
   */
  private readonly consecutiveErrors = new Map<string, number>();
  private readonly consecutiveBusy = new Map<string, number>();

  constructor(
    private readonly resolver: Pick<ResolvePendingReferences, 'findDue' | 'resolve' | 'fail' | 'countPending'>,
    private readonly metrics: ObservabilityMetrics,
    private readonly options: PendingReferenceWorkerOptions,
    private readonly logger: Logger = rootLogger.child({ name: 'PendingReferenceWorker' }),
  ) {}

  start(): void {
    if (this.loop) {
      this.logger.warn({ event: 'pending_reference_worker_already_running' }, 'pending reference worker loop still running');
      return;
    }
    this.running = true;
    this.logger.info({ event: 'pending_reference_worker_started' }, 'pending reference worker started');
    this.loop = this.run().finally(() => {
      this.loop = undefined;
    });
  }

  /**
   * Para de buscar e espera a candidata em andamento commitar, até `shutdownTimeoutMs`. Se o prazo
   * estourar, o loop antigo ainda está terminando e um `start()` logo em seguida é ignorado
   * (`already_running`); só acontece no shutdown do processo.
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
    if (!finished) this.logger.warn({ event: 'pending_reference_worker_shutdown_timeout' }, 'shutdown timeout');
    this.logger.info({ event: 'pending_reference_worker_stopped' }, 'pending reference worker stopped');
  }

  /**
   * Um ciclo. Devolve quantas candidatas avançaram (resolvidas, expiradas ou reagendadas).
   * `keepGoing` é consultado antes de cada candidata (shutdown). Exposto para testes.
   */
  async runOnce(keepGoing: () => boolean = () => true): Promise<{ candidates: number; progressed: number }> {
    const candidates = await this.resolver.findDue(this.options.batchSize);
    let progressed = 0;
    for (const candidate of candidates) {
      if (!keepGoing()) break;
      const outcome = await this.attempt(candidate);
      if (outcome !== undefined && this.record(outcome, candidate.walletId)) progressed++;
    }
    return { candidates: candidates.length, progressed };
  }

  /**
   * Uma tentativa, com as heurísticas por candidata:
   * - erro inesperado (bug, dado inconsistente): log + `skipped{error}`; no `MAX_CONSECUTIVE_ERRORS`º
   *   seguido, encerra como FAILED. Falha transitória não conta nem zera; sucesso zera.
   * - `wallet_busy` seguidos: no `MAX_CONSECUTIVE_BUSY`º, a próxima tentativa espera o lock.
   */
  private async attempt(candidate: PendingReferenceCandidate): Promise<PendingReferenceOutcome | undefined> {
    const id = candidate.id;
    const waitForWallet = (this.consecutiveBusy.get(id) ?? 0) >= MAX_CONSECUTIVE_BUSY;
    let outcome: PendingReferenceOutcome;
    try {
      outcome = await this.resolver.resolve(candidate, { waitForWallet });
    } catch (error) {
      const errors = (this.consecutiveErrors.get(id) ?? 0) + 1;
      this.metrics.pendingReferenceSkipped.inc({ reason: 'error' });
      this.logger.error(
        { event: 'pending_reference_error', transactionId: id, walletId: candidate.walletId, errorName: errorName(error), consecutiveErrors: errors },
        'pending reference resolution failed',
      );
      if (errors < MAX_CONSECUTIVE_ERRORS) {
        track(this.consecutiveErrors, id, errors);
        return undefined;
      }
      return this.failCandidate(candidate);
    }

    if (outcome.type === 'skipped' && outcome.reason === 'wallet_busy') {
      track(this.consecutiveBusy, id, (this.consecutiveBusy.get(id) ?? 0) + 1);
    } else if (outcome.type !== 'transient') {
      this.consecutiveBusy.delete(id);
      this.consecutiveErrors.delete(id);
    }
    return outcome;
  }

  private async failCandidate(candidate: PendingReferenceCandidate): Promise<PendingReferenceOutcome | undefined> {
    try {
      const outcome = await this.resolver.fail(candidate);
      // Transitório: o contador fica no limite e a próxima tentativa com erro tenta encerrar de novo.
      if (outcome.type !== 'transient') {
        this.consecutiveErrors.delete(candidate.id);
        this.consecutiveBusy.delete(candidate.id);
      }
      return outcome;
    } catch (error) {
      this.logger.error(
        { event: 'pending_reference_fail_error', transactionId: candidate.id, walletId: candidate.walletId, errorName: errorName(error) },
        'could not mark pending reference as failed',
      );
      return undefined;
    }
  }

  private record(outcome: PendingReferenceOutcome, walletId: string): boolean {
    const base = { transactionId: outcome.transactionId, walletId };
    switch (outcome.type) {
      case 'resolved':
        this.metrics.pendingReferenceResolved.inc({ status: outcome.status });
        this.logger.info({ ...base, event: 'pending_reference_resolved', status: outcome.status }, 'pending reference resolved');
        return true;
      case 'expired':
        this.metrics.pendingReferenceExpired.inc();
        this.logger.warn({ ...base, event: 'pending_reference_expired' }, 'pending reference expired');
        return true;
      case 'rescheduled':
        this.metrics.pendingReferenceRescheduled.inc();
        this.logger.debug(
          { ...base, event: 'pending_reference_rescheduled', nextReferenceCheckAt: outcome.nextReferenceCheckAt.toISOString() },
          'pending reference rescheduled',
        );
        return true;
      case 'failed':
        this.metrics.pendingReferenceFailed.inc();
        this.logger.error({ ...base, event: 'pending_reference_marked_failed' }, 'pending reference marked FAILED');
        return true;
      case 'skipped':
        this.metrics.pendingReferenceSkipped.inc({ reason: outcome.reason });
        return false;
      case 'transient':
        this.metrics.pendingReferenceSkipped.inc({ reason: 'transient' });
        this.logger.warn({ ...base, event: 'pending_reference_transient', reason: outcome.reason }, 'pending reference transient failure');
        return false;
    }
  }

  private async run(): Promise<void> {
    let failures = 0;
    while (this.running) {
      let cycle: { candidates: number; progressed: number };
      try {
        cycle = await this.runOnce(() => this.running);
        failures = 0;
      } catch (error) {
        failures++;
        const pauseMs = errorPauseMs(failures);
        this.logger.error({ event: 'pending_reference_cycle_failed', errorName: errorName(error), pauseMs }, 'cycle failed');
        await this.pause(pauseMs);
        continue;
      }
      await this.measurePending();
      // Busca de novo na hora enquanto houver avanço. Lote vazio, ou só candidatas puladas
      // (wallet ocupada, outra instância), espera o intervalo: sem laço quente.
      if (cycle.progressed === 0) await this.pause(this.options.pollIntervalMs);
    }
  }

  /** Gauge de pendentes em intervalo fixo, com ou sem carga. */
  private async measurePending(): Promise<void> {
    const nowMs = Date.now();
    if (nowMs - this.lastGaugeAt < this.options.gaugeIntervalMs) return;
    this.lastGaugeAt = nowMs;
    try {
      this.metrics.pendingReferences.set(await this.resolver.countPending());
    } catch (error) {
      this.logger.warn({ event: 'pending_reference_gauge_failed', errorName: errorName(error) }, 'pending gauge failed');
    }
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

/** Grava o contador; acima do teto, descarta tudo (só perde a heurística, nunca a correção). */
function track(counters: Map<string, number>, id: string, value: number): void {
  if (!counters.has(id) && counters.size >= MAX_TRACKED) counters.clear();
  counters.set(id, value);
}

function errorName(error: unknown): string {
  return error instanceof Error ? error.name : typeof error;
}
