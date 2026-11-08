import { InvalidJournalEntryError } from './errors';
import { Money } from './money';
import { WagerTransactionKind, type WagerTransaction } from './wager-transaction';
import { LedgerDirection, type WalletLedgerEntry } from './wallet-ledger-entry';

/**
 * Plano de contas do diário de partidas dobradas (ARCHITECTURE.md → "Diário de partidas dobradas").
 * PLAYER: o que a casa deve ao jogador (uma por wallet). PROVIDER_HOUSE: contrapartida de apostas e
 * prêmios (uma por provider e moeda). FUNDING: contrapartida do OPENING (uma por moeda).
 */
export enum AccountKind {
  Player = 'PLAYER',
  ProviderHouse = 'PROVIDER_HOUSE',
  Funding = 'FUNDING',
}

/** Conta identificada pela chave natural; a moeda é a do lançamento. */
export type AccountRef =
  | { kind: AccountKind.Player; walletId: string }
  | { kind: AccountKind.ProviderHouse; providerId: string }
  | { kind: AccountKind.Funding };

export interface Posting {
  readonly account: AccountRef;
  readonly direction: LedgerDirection;
  readonly money: Money;
}

export interface JournalEntryState {
  id: string;
  transactionId: string;
  currency: string;
  postings: readonly Posting[];
  createdAt: Date;
}

/**
 * Lançamento de diário de uma transação que move saldo: débitos = créditos, numa moeda só.
 * Append-only: sem transições, instância e pernas congeladas.
 */
export class JournalEntry {
  private constructor(
    readonly id: string,
    readonly transactionId: string,
    readonly currency: string,
    readonly postings: readonly Posting[],
    readonly createdAt: Date,
  ) {
    Object.freeze(this);
  }

  static create(props: JournalEntryState): JournalEntry {
    const { postings, currency } = props;
    if (postings.length < 2) throw new InvalidJournalEntryError('o lançamento exige ao menos duas pernas');
    if (postings.some((p) => p.money.currency !== currency)) {
      throw new InvalidJournalEntryError('todas as pernas devem ter a moeda do lançamento');
    }
    if (postings.some((p) => !p.money.isPositive())) {
      throw new InvalidJournalEntryError('o valor de cada perna deve ser positivo');
    }
    const directions = new Set(postings.map((p) => p.direction));
    if (!directions.has(LedgerDirection.Debit) || !directions.has(LedgerDirection.Credit)) {
      throw new InvalidJournalEntryError('o lançamento exige ao menos um débito e um crédito');
    }
    const entry = JournalEntry.rehydrate(props);
    if (!entry.isBalanced()) throw new InvalidJournalEntryError('soma dos débitos deve ser igual à dos créditos');
    return entry;
  }

  static rehydrate(state: JournalEntryState): JournalEntry {
    const postings = Object.freeze(state.postings.map((p) => Object.freeze({ ...p, account: Object.freeze({ ...p.account }) })));
    return new JournalEntry(state.id, state.transactionId, state.currency, postings, new Date(state.createdAt));
  }

  /**
   * Lançamento de diário da transação, derivado do lançamento da wallet: a perna PLAYER tem a mesma
   * direção e valor do `WalletLedgerEntry`; a contrapartida, a direção oposta. Assim o ROLLBACK sai
   * invertido pela mesma regra que já decidiu a direção do ledger. Contrapartida: FUNDING no OPENING,
   * PROVIDER_HOUSE do provider da transação nos demais kinds.
   */
  static forTransaction(id: string, tx: WagerTransaction, ledgerEntry: WalletLedgerEntry): JournalEntry {
    if (ledgerEntry.transactionId !== tx.id || ledgerEntry.walletId !== tx.walletId) {
      throw new InvalidJournalEntryError('o lançamento da wallet não pertence à transação');
    }
    if (!ledgerEntry.money.equals(tx.money)) {
      throw new InvalidJournalEntryError('o valor do lançamento da wallet difere do da transação');
    }
    const counterpart: AccountRef =
      tx.kind === WagerTransactionKind.Opening
        ? { kind: AccountKind.Funding }
        : { kind: AccountKind.ProviderHouse, providerId: tx.providerId };
    const opposite = ledgerEntry.direction === LedgerDirection.Debit ? LedgerDirection.Credit : LedgerDirection.Debit;
    return JournalEntry.create({
      id,
      transactionId: tx.id,
      currency: tx.money.currency,
      postings: [
        { account: { kind: AccountKind.Player, walletId: tx.walletId }, direction: ledgerEntry.direction, money: tx.money },
        { account: counterpart, direction: opposite, money: tx.money },
      ],
      createdAt: ledgerEntry.createdAt,
    });
  }

  /** Σ débitos = Σ créditos, numa moeda só (pernas de outra moeda tornam o lançamento desbalanceado). */
  isBalanced(): boolean {
    if (this.postings.some((p) => p.money.currency !== this.currency)) return false;
    const total = (direction: LedgerDirection): Money =>
      this.postings.filter((p) => p.direction === direction).reduce((sum, p) => sum.add(p.money), Money.zero(this.currency));
    return total(LedgerDirection.Debit).equals(total(LedgerDirection.Credit));
  }
}
