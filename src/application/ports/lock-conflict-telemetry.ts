export type LockConflictReason = 'lock_timeout' | 'deadlock' | 'version_conflict';

export interface LockConflict {
  reason: LockConflictReason;
  walletId: string;
  correlationId: string;
}

/** Registra conflitos de concorrência por wallet (log estruturado + contador; métricas reais na Fase 8). */
export interface LockConflictTelemetry {
  lockConflict(conflict: LockConflict): void;
}
