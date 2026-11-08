import type { Logger } from 'pino';
import type { LockConflict, LockConflictTelemetry } from '../../application/ports/lock-conflict-telemetry';
import { rootLogger } from './logger';
import type { ObservabilityMetrics } from './metrics';

/** Log `warn` (pino) + `wagering_lock_conflicts_total{reason}`. O log não carrega payload financeiro. */
export class LoggingLockConflictTelemetry implements LockConflictTelemetry {
  constructor(
    private readonly metrics: ObservabilityMetrics,
    private readonly logger: Logger = rootLogger.child({ name: 'LockConflictTelemetry' }),
  ) {}

  lockConflict(conflict: LockConflict): void {
    this.metrics.lockConflicts.inc({ reason: conflict.reason });
    this.logger.warn(
      {
        event: 'wallet_lock_conflict',
        reason: conflict.reason,
        walletId: conflict.walletId,
        correlationId: conflict.correlationId,
      },
      'wallet lock conflict',
    );
  }
}
