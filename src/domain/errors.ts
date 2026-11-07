/** Base de todos os erros de domínio. Nunca carrega payload financeiro completo na mensagem. */
export abstract class DomainError extends Error {
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

export class InvalidMoneyError extends DomainError {}

export class CurrencyMismatchError extends DomainError {
  constructor(
    readonly expected: string,
    readonly actual: string,
  ) {
    super(`moeda divergente: esperado ${expected}, recebido ${actual}`);
  }
}

export class InsufficientBalanceError extends DomainError {
  constructor(readonly walletId: string) {
    super(`saldo insuficiente na wallet ${walletId}`);
  }
}

export class InvalidLedgerEntryError extends DomainError {}

export class InvalidWagerTransactionError extends DomainError {}

/** Transição a partir de estado terminal ou não permitida: erro de programação, não caminho de negócio. */
export class InvalidTransactionStateError extends DomainError {
  constructor(
    readonly transactionId: string,
    readonly currentStatus: string,
    readonly attempted: string,
  ) {
    super(`transação ${transactionId}: transição inválida de ${currentStatus} para ${attempted}`);
  }
}

/** Transição inválida em mensagem de inbox/outbox (ex.: publicar duas vezes). */
export class InvalidMessageStateError extends DomainError {}
