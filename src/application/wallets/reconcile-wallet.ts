import { Money, type MoneyProps } from '../../domain/money';
import {
  kindAffectsBalance,
  ledgerDirectionForKind,
  WagerTransactionKind,
  WagerTransactionStatus,
} from '../../domain/wager-transaction';
import { LedgerDirection } from '../../domain/wallet-ledger-entry';
import type { ReconciliationEntryRow, WalletReconciliationReader } from '../ports/wallet-reconciliation-reader';

/** Tipos estáveis de divergência (ARCHITECTURE.md → "Reconciliação"). */
export type DivergenceType =
  /** O lançamento aponta para uma transação inexistente, de outra wallet ou que não está PROCESSED. */
  | 'ENTRY_WITHOUT_PROCESSED_TRANSACTION'
  /** O lançamento aponta para uma transação PROCESSED que não move saldo (LOSS). */
  | 'ENTRY_TRANSACTION_DOES_NOT_MOVE_BALANCE'
  /** O valor ou a moeda do lançamento diferem dos da transação. */
  | 'ENTRY_AMOUNT_MISMATCH'
  /** A direção do lançamento não é a que o kind da transação exige. */
  | 'ENTRY_DIRECTION_MISMATCH'
  /** Transação PROCESSED que move saldo sem lançamento. */
  | 'PROCESSED_WITHOUT_ENTRY'
  /** Transação PROCESSED com mais de um lançamento (o extra só pode estar em outra wallet: o schema impede dois na mesma). */
  | 'PROCESSED_WITH_MULTIPLE_ENTRIES'
  /** O saldo guardado difere da soma do ledger. */
  | 'BALANCE_MISMATCH';

export interface Divergence {
  type: DivergenceType;
  transactionId?: string;
  ledgerEntryId?: string;
}

/** Teto da lista devolvida; `divergenceCount` traz o total. */
export const MAX_REPORTED_DIVERGENCES = 100;

export type ReconcileWalletResult =
  | { type: 'NotFound' }
  | {
      type: 'Reconciled';
      storedBalance: MoneyProps;
      calculatedBalance: MoneyProps;
      difference: MoneyProps;
      consistent: boolean;
      checkedEntries: number;
      divergenceCount: number;
      divergences: Divergence[];
    };

const KINDS = new Set<string>(Object.values(WagerTransactionKind));

/**
 * Reconciliação (CHALLENGE §9) de uma wallet: confere o saldo com a soma do ledger e cruza o
 * ledger com as transações. Só lê: nunca corrige. As regras de direção e de "move saldo" são as
 * do domínio (`ledgerDirectionForKind`, `kindAffectsBalance`), as mesmas usadas para gravar.
 */
export class ReconcileWallet {
  constructor(private readonly reader: WalletReconciliationReader) {}

  async execute(walletId: string): Promise<ReconcileWalletResult> {
    const snapshot = await this.reader.read(walletId);
    if (snapshot === undefined) return { type: 'NotFound' };

    const divergences: Divergence[] = [];
    const stored = Money.from({ amount: snapshot.balance, currency: snapshot.currency });
    let calculated = Money.zero(snapshot.currency);

    for (const entry of snapshot.entries) {
      const money = Money.from({ amount: entry.amount, currency: entry.currency });
      // Moeda diferente da wallet não entra na soma (Money recusa somar moedas diferentes); vira divergência de valor.
      if (money.currency === stored.currency) {
        calculated = entry.direction === LedgerDirection.Credit ? calculated.add(money) : calculated.subtract(money);
      }
      const problem = entryProblem(walletId, entry, money);
      if (problem) divergences.push({ type: problem, transactionId: entry.transactionId, ledgerEntryId: entry.entryId });
    }

    for (const tx of snapshot.processed) {
      if (!KINDS.has(tx.kind) || !kindAffectsBalance(tx.kind as WagerTransactionKind)) continue;
      if (tx.entries === 0) divergences.push({ type: 'PROCESSED_WITHOUT_ENTRY', transactionId: tx.transactionId });
      if (tx.entries > 1) divergences.push({ type: 'PROCESSED_WITH_MULTIPLE_ENTRIES', transactionId: tx.transactionId });
    }

    if (!stored.equals(calculated)) divergences.push({ type: 'BALANCE_MISMATCH' });

    return {
      type: 'Reconciled',
      storedBalance: stored.toJSON(),
      calculatedBalance: calculated.toJSON(),
      difference: stored.subtract(calculated).toJSON(),
      consistent: divergences.length === 0,
      checkedEntries: snapshot.entries.length,
      divergenceCount: divergences.length,
      divergences: divergences.slice(0, MAX_REPORTED_DIVERGENCES),
    };
  }
}

/** Primeira divergência do lançamento contra a transação dele, ou `undefined` se ele está certo. */
function entryProblem(walletId: string, entry: ReconciliationEntryRow, money: Money): DivergenceType | undefined {
  const tx = entry.transaction;
  if (tx === undefined || tx.walletId !== walletId || tx.status !== WagerTransactionStatus.Processed || !KINDS.has(tx.kind)) {
    return 'ENTRY_WITHOUT_PROCESSED_TRANSACTION';
  }
  const kind = tx.kind as WagerTransactionKind;
  if (!kindAffectsBalance(kind)) return 'ENTRY_TRANSACTION_DOES_NOT_MOVE_BALANCE';
  if (!money.equals(Money.from({ amount: tx.amount, currency: tx.currency }))) return 'ENTRY_AMOUNT_MISMATCH';
  let expected: LedgerDirection;
  try {
    expected = ledgerDirectionForKind(kind, KINDS.has(tx.referenceKind ?? '') ? (tx.referenceKind as WagerTransactionKind) : undefined);
  } catch {
    // ROLLBACK sem referência aceitável: não há direção certa possível.
    return 'ENTRY_DIRECTION_MISMATCH';
  }
  return entry.direction === expected ? undefined : 'ENTRY_DIRECTION_MISMATCH';
}
