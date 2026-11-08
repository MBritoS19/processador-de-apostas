import { exponentialBackoffMs } from '../domain/backoff';

const ERROR_PAUSE_BASE_MS = 1_000;
const ERROR_PAUSE_MAX_MS = 30_000;

/** Pausa do loop (consumidor, outbox, pendentes) quando o próprio ciclo falha: 1s·2^(n−1), até 30s. */
export function errorPauseMs(consecutiveFailures: number): number {
  return exponentialBackoffMs(Math.max(consecutiveFailures, 1), ERROR_PAUSE_BASE_MS, ERROR_PAUSE_MAX_MS);
}
