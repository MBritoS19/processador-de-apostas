/**
 * Backoff exponencial determinístico: base · 2^(attempt−1), limitado por `maxMs`.
 * `attempt` começa em 1 (primeira nova tentativa); o expoente para em 30.
 */
export function exponentialBackoffMs(attempt: number, baseMs: number, maxMs: number): number {
  if (!Number.isInteger(attempt) || attempt < 1) {
    throw new RangeError('attempt deve ser um inteiro >= 1');
  }
  return Math.min(baseMs * 2 ** Math.min(attempt - 1, 30), maxMs);
}

export function addMs(date: Date, ms: number): Date {
  return new Date(date.getTime() + ms);
}
