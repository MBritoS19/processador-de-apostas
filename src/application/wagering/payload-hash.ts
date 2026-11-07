import { createHash } from 'node:crypto';
import type { Money } from '../../domain/money';

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
