import { EntitySchema } from '@mikro-orm/core';
import { Money } from '../../domain/money';
import { WalletLedgerEntry, type LedgerDirection } from '../../domain/wallet-ledger-entry';

/**
 * Linha de `wallet_ledger_entries` (append-only). A coluna `seq` (cursor do ledger) é gerada
 * pelo banco e não é mapeada aqui: a consulta paginada do ledger a lê diretamente.
 */
export class LedgerEntryRecord {
  id!: string;
  walletId!: string;
  transactionId!: string;
  direction!: LedgerDirection;
  amount!: string;
  currency!: string;
  balanceBefore!: string;
  balanceAfter!: string;
  createdAt!: Date;
}

const money = { type: 'decimal', precision: 20, scale: 2, runtimeType: 'string' } as const;

export const LedgerEntrySchema = new EntitySchema<LedgerEntryRecord>({
  class: LedgerEntryRecord,
  tableName: 'wallet_ledger_entries',
  properties: {
    id: { type: 'uuid', primary: true },
    walletId: { type: 'uuid' },
    transactionId: { type: 'uuid' },
    direction: { type: 'text' },
    amount: money,
    currency: { type: 'string', length: 3 },
    balanceBefore: money,
    balanceAfter: money,
    createdAt: { type: 'Date' },
  },
});

export function toLedgerEntryRecord(entry: WalletLedgerEntry): LedgerEntryRecord {
  return Object.assign(new LedgerEntryRecord(), {
    id: entry.id,
    walletId: entry.walletId,
    transactionId: entry.transactionId,
    direction: entry.direction,
    amount: entry.money.amount,
    currency: entry.money.currency,
    balanceBefore: entry.balanceBefore.amount,
    balanceAfter: entry.balanceAfter.amount,
    createdAt: entry.createdAt,
  });
}

export function toLedgerEntry(record: LedgerEntryRecord): WalletLedgerEntry {
  const money = (amount: string) => Money.from({ amount, currency: record.currency });
  return WalletLedgerEntry.rehydrate({
    id: record.id,
    walletId: record.walletId,
    transactionId: record.transactionId,
    direction: record.direction,
    money: money(record.amount),
    balanceBefore: money(record.balanceBefore),
    balanceAfter: money(record.balanceAfter),
    createdAt: record.createdAt,
  });
}
