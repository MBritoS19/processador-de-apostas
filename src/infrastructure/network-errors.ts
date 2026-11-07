const NETWORK_ERROR_CODES = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'ENOTFOUND',
  'EAI_AGAIN',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'ETIMEDOUT',
  'EPIPE',
  'ConnectionRefused',
]);

/**
 * Detecta falha de rede/conexão em erros de drivers Node (pg, AWS SDK),
 * percorrendo `cause` e `AggregateError.errors` (happy eyeballs devolve AggregateError).
 */
export function isNetworkError(error: unknown, depth = 0): boolean {
  if (depth > 5 || typeof error !== 'object' || error === null) return false;

  const { code, cause, errors } = error as { code?: unknown; cause?: unknown; errors?: unknown };
  if (typeof code === 'string' && NETWORK_ERROR_CODES.has(code)) return true;
  if (Array.isArray(errors) && errors.some((inner) => isNetworkError(inner, depth + 1))) return true;
  return isNetworkError(cause, depth + 1);
}
