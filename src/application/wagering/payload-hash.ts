import { createHash } from 'node:crypto';
import { Money, type MoneyProps } from '../../domain/money';

/** Campos de negócio que entram no hash. Header (Idempotency-Key) e metadados de transporte ficam fora. */
export interface HashablePayload {
  providerId: string;
  externalTransactionId: string;
  playerId: string;
  walletId: string;
  roundId: string;
  gameId: string;
  kind: string;
  money: Money;
  referenceExternalTransactionId?: string | undefined;
}

type Json = string | number | boolean | null | Json[] | { [key: string]: Json };

/** JSON canônico: chaves ordenadas (por code unit, recursivo), sem espaços. */
export function canonicalJson(value: Json): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const keys = Object.keys(value).sort();
    return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key] as Json)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

/**
 * SHA-256 (hex) do JSON canônico do payload. `money.amount` já vem normalizado com 2 casas
 * pelo `Money` ("25" e "25.00" geram o mesmo hash); referência ausente entra como `null`.
 */
export function wagerPayloadHash(payload: HashablePayload): string {
  const canonical = canonicalJson({
    providerId: payload.providerId,
    externalTransactionId: payload.externalTransactionId,
    playerId: payload.playerId,
    walletId: payload.walletId,
    roundId: payload.roundId,
    gameId: payload.gameId,
    kind: payload.kind,
    money: { amount: payload.money.amount, currency: payload.money.currency },
    referenceExternalTransactionId: payload.referenceExternalTransactionId ?? null,
  });
  return createHash('sha256').update(canonical, 'utf8').digest('hex');
}

const TEXT_FIELDS = ['providerId', 'externalTransactionId', 'playerId', 'walletId', 'roundId', 'gameId', 'kind'] as const;

/**
 * O mesmo `wagerPayloadHash` do use case, calculado a partir do payload cru (antes da validação
 * completa), com a mesma normalização do `parse`: `Money` (2 casas), `walletId` em minúsculas e
 * referência ausente ou `null` = sem referência. `undefined` se o payload não for normalizável
 * (o use case o rejeitaria como `InvalidInput`). Um teste de unidade amarra os dois cálculos.
 */
export function wagerPayloadHashOfRaw(data: Record<string, unknown>): string | undefined {
  if (TEXT_FIELDS.some((field) => typeof data[field] !== 'string')) return undefined;
  const reference = data['referenceExternalTransactionId'];
  if (reference !== undefined && reference !== null && typeof reference !== 'string') return undefined;
  let money: Money;
  try {
    money = Money.from(data['money'] as MoneyProps);
  } catch {
    return undefined;
  }
  return wagerPayloadHash({
    providerId: data['providerId'] as string,
    externalTransactionId: data['externalTransactionId'] as string,
    playerId: data['playerId'] as string,
    walletId: (data['walletId'] as string).toLowerCase(),
    roundId: data['roundId'] as string,
    gameId: data['gameId'] as string,
    kind: data['kind'] as string,
    money,
    referenceExternalTransactionId: typeof reference === 'string' ? reference : undefined,
  });
}
