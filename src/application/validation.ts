/** Limite dos ids e da key: cabe folgado nos índices btree (o Postgres recusa entradas de ~2.7 KB). */
const MAX_TEXT_LENGTH = 256;

export const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Texto obrigatório, não vazio, até MAX_TEXT_LENGTH. Devolve o problema ou undefined. */
export function textProblem(field: string, value: unknown): string | undefined {
  if (value === undefined || value === null) return `${field} é obrigatório`;
  if (typeof value !== 'string') return `${field} deve ser texto`;
  if (value.trim() === '') return `${field} não pode ser vazio`;
  if (value.length > MAX_TEXT_LENGTH) return `${field} excede ${MAX_TEXT_LENGTH} caracteres`;
  return undefined;
}
