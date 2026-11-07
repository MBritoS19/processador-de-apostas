import { EntitySchema } from '@mikro-orm/core';
import { Money } from '../../domain/money';
import { Wallet } from '../../domain/wallet';

/** Linha de `wallets`. `balance` é a string exata do numeric(20,2), nunca `number`. */
export class WalletRecord {
  id!: string;
  playerId!: string;
  currency!: string;
  balance!: string;
  version!: number;
  createdAt!: Date;
  updatedAt!: Date;
}

export const WalletSchema = new EntitySchema<WalletRecord>({
  class: WalletRecord,
  tableName: 'wallets',
  properties: {
    id: { type: 'uuid', primary: true },
    playerId: { type: 'text' },
    currency: { type: 'string', length: 3 },
    balance: { type: 'decimal', precision: 20, scale: 2, runtimeType: 'string' },
    version: { type: 'integer' },
    createdAt: { type: 'Date' },
    updatedAt: { type: 'Date' },
  },
});

export function toWalletRecord(wallet: Wallet): WalletRecord {
  return Object.assign(new WalletRecord(), {
    id: wallet.id,
    playerId: wallet.playerId,
    currency: wallet.currency,
    balance: wallet.balance.amount,
    version: wallet.version,
    createdAt: wallet.createdAt,
    updatedAt: wallet.updatedAt,
  });
}

export function toWallet(record: WalletRecord): Wallet {
  return Wallet.rehydrate({
    id: record.id,
    playerId: record.playerId,
    currency: record.currency,
    balance: Money.from({ amount: record.balance, currency: record.currency }),
    version: record.version,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  });
}
