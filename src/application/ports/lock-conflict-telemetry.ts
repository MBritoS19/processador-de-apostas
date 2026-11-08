export type LockConflictReason = 'lock_timeout' | 'deadlock' | 'version_conflict';

export interface LockConflict {
  reason: LockConflictReason;
  walletId: string;
  correlationId: string;
}

/** Registra conflitos de concorrência por wallet (log estruturado + métrica). */
export interface LockConflictTelemetry {
  lockConflict(conflict: LockConflict): void;
}
