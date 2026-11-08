/** `local_lock_timeout`: o orçamento acabou ainda no mutex local da wallet (sem abrir transação). */
export type LockConflictReason = 'lock_timeout' | 'deadlock' | 'version_conflict' | 'local_lock_timeout';

export interface LockConflict {
  reason: LockConflictReason;
  walletId: string;
  correlationId: string;
}

/** Registra conflitos de concorrência por wallet (log estruturado + métrica). */
export interface LockConflictTelemetry {
  lockConflict(conflict: LockConflict): void;
}
