import { EntitySchema } from '@mikro-orm/core';
import type { FailureCode } from '../../domain/failure-code';
import { Money } from '../../domain/money';
import {
  WagerTransaction,
  type WagerTransactionKind,
  type WagerTransactionStatus,
} from '../../domain/wager-transaction';

/** Linha de `wager_transactions`. Valores monetários na moeda da transação (`currency`). */
export class WagerTransactionRecord {
  id!: string;
  providerId!: string;
  externalTransactionId!: string;
  idempotencyKey!: string;
  payloadHash!: string;
  walletId!: string;
  playerId!: string;
  roundId!: string;
  gameId!: string;
  kind!: WagerTransactionKind;
  amount!: string;
  currency!: string;
  referenceExternalTransactionId!: string | null;
  referenceTransactionId!: string | null;
  status!: WagerTransactionStatus;
  failureCode!: FailureCode | null;
  processedAt!: Date | null;
  observedBalance!: string | null;
  referenceAttempts!: number;
  nextReferenceCheckAt!: Date | null;
  createdAt!: Date;
  correlationId!: string | null;
}

const money = { type: 'decimal', precision: 20, scale: 2, runtimeType: 'string' } as const;

export const WagerTransactionSchema = new EntitySchema<WagerTransactionRecord>({
  class: WagerTransactionRecord,
  tableName: 'wager_transactions',
  properties: {
    id: { type: 'uuid', primary: true },
    providerId: { type: 'text' },
    externalTransactionId: { type: 'text' },
    idempotencyKey: { type: 'text' },
    payloadHash: { type: 'text' },
    walletId: { type: 'uuid' },
    playerId: { type: 'text' },
    roundId: { type: 'text' },
    gameId: { type: 'text' },
    kind: { type: 'text' },
    amount: money,
    currency: { type: 'string', length: 3 },
    referenceExternalTransactionId: { type: 'text', nullable: true },
    referenceTransactionId: { type: 'uuid', nullable: true },
    status: { type: 'text' },
    failureCode: { type: 'text', nullable: true },
    processedAt: { type: 'Date', nullable: true },
    observedBalance: { ...money, nullable: true },
    referenceAttempts: { type: 'integer' },
    nextReferenceCheckAt: { type: 'Date', nullable: true },
    createdAt: { type: 'Date' },
    correlationId: { type: 'text', nullable: true },
  },
});

export function toWagerTransactionRecord(tx: WagerTransaction): WagerTransactionRecord {
  return Object.assign(new WagerTransactionRecord(), {
    id: tx.id,
    providerId: tx.providerId,
    externalTransactionId: tx.externalTransactionId,
    idempotencyKey: tx.idempotencyKey,
    payloadHash: tx.payloadHash,
    walletId: tx.walletId,
    playerId: tx.playerId,
    roundId: tx.roundId,
    gameId: tx.gameId,
    kind: tx.kind,
    amount: tx.money.amount,
    currency: tx.money.currency,
    referenceExternalTransactionId: tx.referenceExternalTransactionId ?? null,
    referenceTransactionId: tx.referenceTransactionId ?? null,
    status: tx.status,
    failureCode: tx.failureCode ?? null,
    processedAt: tx.processedAt ?? null,
    observedBalance: tx.observedBalance?.amount ?? null,
    referenceAttempts: tx.referenceAttempts,
    nextReferenceCheckAt: tx.nextReferenceCheckAt ?? null,
    createdAt: tx.createdAt,
    correlationId: tx.correlationId ?? null,
  });
}

export function toWagerTransaction(record: WagerTransactionRecord): WagerTransaction {
  const { currency } = record;
  return WagerTransaction.rehydrate({
    id: record.id,
    providerId: record.providerId,
    externalTransactionId: record.externalTransactionId,
    idempotencyKey: record.idempotencyKey,
    payloadHash: record.payloadHash,
    walletId: record.walletId,
    playerId: record.playerId,
    roundId: record.roundId,
    gameId: record.gameId,
    kind: record.kind,
    money: Money.from({ amount: record.amount, currency }),
    referenceExternalTransactionId: record.referenceExternalTransactionId ?? undefined,
    referenceTransactionId: record.referenceTransactionId ?? undefined,
    status: record.status,
    failureCode: record.failureCode ?? undefined,
    processedAt: record.processedAt ?? undefined,
    observedBalance: record.observedBalance === null ? undefined : Money.from({ amount: record.observedBalance, currency }),
    referenceAttempts: record.referenceAttempts,
    nextReferenceCheckAt: record.nextReferenceCheckAt ?? undefined,
    createdAt: record.createdAt,
    correlationId: record.correlationId ?? undefined,
  });
}
