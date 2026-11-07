import type {
  LockConflict,
  LockConflictReason,
  LockConflictTelemetry,
} from '../../application/ports/lock-conflict-telemetry';
import type { ObservabilityMetrics } from './metrics';

/**
 * Log JSON de uma linha + contador em memória por motivo. Provisório: as métricas
 * de verdade (exportáveis) entram na Fase 8. O log não carrega payload financeiro.
 */
export class LoggingLockConflictTelemetry implements LockConflictTelemetry {
  private readonly counts = new Map<LockConflictReason, number>();

  constructor(
    private readonly write: (line: string) => void = (line) => console.warn(line),
    private readonly metrics?: ObservabilityMetrics,
  ) {}

  lockConflict(conflict: LockConflict): void {
    this.counts.set(conflict.reason, this.count(conflict.reason) + 1);
    this.metrics?.lockConflicts.inc();
    this.write(
      JSON.stringify({
        level: 'warn',
        event: 'wallet_lock_conflict',
        reason: conflict.reason,
        walletId: conflict.walletId,
        correlationId: conflict.correlationId,
      }),
    );
  }

  count(reason?: LockConflictReason): number {
    if (reason !== undefined) return this.counts.get(reason) ?? 0;
    return [...this.counts.values()].reduce((total, n) => total + n, 0);
  }
}
