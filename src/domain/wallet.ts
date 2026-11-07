import { CurrencyMismatchError, InsufficientBalanceError, InvalidMoneyError } from './errors';
import { Money } from './money';
import { LedgerDirection, WalletLedgerEntry } from './wallet-ledger-entry';

export interface WalletState {
  id: string;
  playerId: string;
  currency: string;
  balance: Money;
  version: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface OpenWalletProps {
  id: string;
  playerId: string;
  initialBalance: Money;
  /** Transação OPENING que origina o crédito de abertura. */
  openingTransactionId: string;
  openingEntryId: string;
  at: Date;
}

export interface WalletMovementProps {
  entryId: string;
  transactionId: string;
  money: Money;
  at: Date;
}

/** Aggregate root. Toda alteração de saldo produz exatamente um WalletLedgerEntry. */
export class Wallet {
  private constructor(
    readonly id: string,
    readonly playerId: string,
    readonly currency: string,
    private _balance: Money,
    private _version: number,
    readonly createdAt: Date,
    private _updatedAt: Date,
  ) {}

  /**
   * Abre a wallet já com o saldo inicial e version = 1. Saldo inicial positivo gera o
   * lançamento CREDIT da transação OPENING; saldo zero não gera lançamento.
   */
  static open(props: OpenWalletProps): { wallet: Wallet; openingEntry: WalletLedgerEntry | undefined } {
    const { initialBalance, at } = props;
    if (initialBalance.isNegative()) {
      throw new InvalidMoneyError('saldo inicial não pode ser negativo');
    }
    const openingEntry = initialBalance.isZero()
      ? undefined
      : WalletLedgerEntry.create({
          id: props.openingEntryId,
          walletId: props.id,
          transactionId: props.openingTransactionId,
          direction: LedgerDirection.Credit,
          money: initialBalance,
          balanceBefore: Money.zero(initialBalance.currency),
          balanceAfter: initialBalance,
          createdAt: at,
        });
    const wallet = new Wallet(props.id, props.playerId, initialBalance.currency, initialBalance, 1, at, at);
    return { wallet, openingEntry };
  }

  /** Reconstrução a partir da persistência — não revalida regras. */
  static rehydrate(state: WalletState): Wallet {
    return new Wallet(
      state.id,
      state.playerId,
      state.currency,
      state.balance,
      state.version,
      new Date(state.createdAt),
      new Date(state.updatedAt),
    );
  }

  get balance(): Money {
    return this._balance;
  }

  get version(): number {
    return this._version;
  }

  get updatedAt(): Date {
    return this._updatedAt;
  }

  /** Lança InsufficientBalanceError se o saldo não cobre o valor; nada muda nesse caso. */
  debit(props: WalletMovementProps): WalletLedgerEntry {
    this.assertSameCurrency(props.money);
    if (this._balance.isLessThan(props.money)) {
      throw new InsufficientBalanceError(this.id);
    }
    return this.apply(LedgerDirection.Debit, props);
  }

  credit(props: WalletMovementProps): WalletLedgerEntry {
    this.assertSameCurrency(props.money);
    return this.apply(LedgerDirection.Credit, props);
  }

  /** Cria o lançamento antes de mutar: se ele for inválido, a wallet fica intacta. */
  private apply(direction: LedgerDirection, props: WalletMovementProps): WalletLedgerEntry {
    const balanceAfter =
      direction === LedgerDirection.Credit
        ? this._balance.add(props.money)
        : this._balance.subtract(props.money);
    const entry = WalletLedgerEntry.create({
      id: props.entryId,
      walletId: this.id,
      transactionId: props.transactionId,
      direction,
      money: props.money,
      balanceBefore: this._balance,
      balanceAfter,
      createdAt: props.at,
    });
    this._balance = balanceAfter;
    this._version += 1;
    this._updatedAt = props.at;
    return entry;
  }

  private assertSameCurrency(money: Money): void {
    if (money.currency !== this.currency) {
      throw new CurrencyMismatchError(this.currency, money.currency);
    }
  }
}
