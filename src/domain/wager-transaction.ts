import { addMs, exponentialBackoffMs } from './backoff';
import { InvalidTransactionStateError, InvalidWagerTransactionError } from './errors';
import type { FailureCode } from './failure-code';
import type { Money } from './money';
import { LedgerDirection } from './wallet-ledger-entry';

export enum WagerTransactionKind {
  /** Interno: crédito de abertura da wallet. Não pode ser submetido pela API nem pela fila. */
  Opening = 'OPENING',
  Bet = 'BET',
  Win = 'WIN',
  Loss = 'LOSS',
  Refund = 'REFUND',
  Rollback = 'ROLLBACK',
}

export enum WagerTransactionStatus {
  Pending = 'PENDING',
  PendingReference = 'PENDING_REFERENCE',
  Processed = 'PROCESSED',
  Rejected = 'REJECTED',
  Failed = 'FAILED',
}

/** Provider das transações internas (OPENING). Reservado: nenhum provider externo pode usá-lo. */
export const INTERNAL_PROVIDER_ID = 'internal';
/** Prefixo da idempotency key (e do id externo) da OPENING. Reservado para providers externos. */
export const OPENING_KEY_PREFIX = 'opening:';

/** Backoff entre tentativas de resolver a referência (o limite de tentativas é da Fase 7). */
export const REFERENCE_RETRY_BASE_MS = 5_000;
export const REFERENCE_RETRY_MAX_MS = 10 * 60_000;

const TERMINAL = new Set([
  WagerTransactionStatus.Processed,
  WagerTransactionStatus.Rejected,
  WagerTransactionStatus.Failed,
]);
/** Kinds que revertem outra transação (e por isso exigem referência). Fonte única para application e infra. */
export const REVERSAL_KINDS: readonly WagerTransactionKind[] = Object.freeze([
  WagerTransactionKind.Refund,
  WagerTransactionKind.Rollback,
]);
const REVERSALS = new Set(REVERSAL_KINDS);
const ROLLBACKABLE = new Set([WagerTransactionKind.Bet, WagerTransactionKind.Win, WagerTransactionKind.Refund]);
const BET_ONLY = new Set([WagerTransactionKind.Bet]);
/** Kinds que a referência de cada operação pode ter. WIN/LOSS só referenciam a BET da rodada. */
const REFERENCEABLE: Partial<Record<WagerTransactionKind, ReadonlySet<WagerTransactionKind>>> = {
  [WagerTransactionKind.Win]: BET_ONLY,
  [WagerTransactionKind.Loss]: BET_ONLY,
  [WagerTransactionKind.Refund]: BET_ONLY,
  [WagerTransactionKind.Rollback]: ROLLBACKABLE,
};

export interface CreateWagerTransactionProps {
  id: string;
  providerId: string;
  externalTransactionId: string;
  idempotencyKey: string;
  payloadHash: string;
  walletId: string;
  playerId: string;
  roundId: string;
  gameId: string;
  kind: WagerTransactionKind;
  money: Money;
  /** id no provedor — não o id interno. */
  referenceExternalTransactionId?: string | undefined;
  createdAt: Date;
}

export interface WagerTransactionState extends CreateWagerTransactionProps {
  status: WagerTransactionStatus;
  referenceTransactionId?: string | undefined;
  failureCode?: FailureCode | undefined;
  processedAt?: Date | undefined;
  referenceAttempts: number;
  nextReferenceCheckAt?: Date | undefined;
  /** Saldo da wallet observado no processamento (na moeda da transação), devolvido no replay. */
  observedBalance?: Money | undefined;
}

/**
 * Transições válidas:
 *   PENDING           → PENDING_REFERENCE | PROCESSED | REJECTED | FAILED
 *   PENDING_REFERENCE → PENDING_REFERENCE (nova tentativa) | PROCESSED | REJECTED | FAILED
 * PROCESSED, REJECTED e FAILED são terminais.
 */
export class WagerTransaction {
  readonly id: string;
  readonly providerId: string;
  readonly externalTransactionId: string;
  readonly idempotencyKey: string;
  readonly payloadHash: string;
  readonly walletId: string;
  readonly playerId: string;
  readonly roundId: string;
  readonly gameId: string;
  readonly kind: WagerTransactionKind;
  readonly money: Money;
  readonly referenceExternalTransactionId: string | undefined;
  readonly createdAt: Date;
  private _status: WagerTransactionStatus;
  private _referenceTransactionId: string | undefined;
  private _failureCode: FailureCode | undefined;
  private _processedAt: Date | undefined;
  private _referenceAttempts: number;
  private _nextReferenceCheckAt: Date | undefined;
  private _observedBalance: Money | undefined;

  private constructor(state: WagerTransactionState) {
    this.id = state.id;
    this.providerId = state.providerId;
    this.externalTransactionId = state.externalTransactionId;
    this.idempotencyKey = state.idempotencyKey;
    this.payloadHash = state.payloadHash;
    this.walletId = state.walletId;
    this.playerId = state.playerId;
    this.roundId = state.roundId;
    this.gameId = state.gameId;
    this.kind = state.kind;
    this.money = state.money;
    this.referenceExternalTransactionId = state.referenceExternalTransactionId;
    this.createdAt = new Date(state.createdAt);
    this._status = state.status;
    this._referenceTransactionId = state.referenceTransactionId;
    this._failureCode = state.failureCode;
    this._processedAt = state.processedAt && new Date(state.processedAt);
    this._referenceAttempts = state.referenceAttempts;
    this._nextReferenceCheckAt = state.nextReferenceCheckAt && new Date(state.nextReferenceCheckAt);
    this._observedBalance = state.observedBalance;
  }

  /** Nasce em PENDING. Rejeita OPENING e valida a exigência de referência e de valor por kind. */
  static create(props: CreateWagerTransactionProps): WagerTransaction {
    const { kind, money, referenceExternalTransactionId: reference } = props;
    if (kind === WagerTransactionKind.Opening) {
      throw new InvalidWagerTransactionError('OPENING é interno e não pode ser submetido');
    }
    if (REVERSALS.has(kind) && (reference === undefined || reference.trim() === '')) {
      throw new InvalidWagerTransactionError(`${kind} exige referenceExternalTransactionId`);
    }
    if (kind === WagerTransactionKind.Loss ? money.isNegative() : !money.isPositive()) {
      throw new InvalidWagerTransactionError(`valor inválido para ${kind}`);
    }
    return new WagerTransaction({ ...props, status: WagerTransactionStatus.Pending, referenceAttempts: 0 });
  }

  /**
   * OPENING interno da abertura de wallet: nasce PROCESSED em `createdAt`, com o saldo inicial
   * como saldo observado. Só para o provider interno e com valor positivo (saldo zero não abre OPENING).
   */
  static opening(props: CreateWagerTransactionProps): WagerTransaction {
    if (props.kind !== WagerTransactionKind.Opening) {
      throw new InvalidWagerTransactionError('opening só cria transações OPENING');
    }
    if (props.providerId !== INTERNAL_PROVIDER_ID) {
      throw new InvalidWagerTransactionError('OPENING pertence ao provider interno');
    }
    if (props.referenceExternalTransactionId !== undefined) {
      throw new InvalidWagerTransactionError('OPENING não referencia outra transação');
    }
    if (!props.money.isPositive()) {
      throw new InvalidWagerTransactionError('OPENING exige valor positivo');
    }
    return new WagerTransaction({
      ...props,
      status: WagerTransactionStatus.Processed,
      referenceAttempts: 0,
      processedAt: props.createdAt,
      observedBalance: props.money,
    });
  }

  /** Reconstrução a partir da persistência — não revalida transições. */
  static rehydrate(state: WagerTransactionState): WagerTransaction {
    return new WagerTransaction(state);
  }

  get status(): WagerTransactionStatus {
    return this._status;
  }

  get referenceTransactionId(): string | undefined {
    return this._referenceTransactionId;
  }

  get failureCode(): FailureCode | undefined {
    return this._failureCode;
  }

  get processedAt(): Date | undefined {
    return this._processedAt;
  }

  get referenceAttempts(): number {
    return this._referenceAttempts;
  }

  get nextReferenceCheckAt(): Date | undefined {
    return this._nextReferenceCheckAt;
  }

  get observedBalance(): Money | undefined {
    return this._observedBalance;
  }

  /** `observedBalance`: saldo da wallet depois de aplicar a transação (o atual, em LOSS). */
  markProcessed(referenceTransactionId: string | undefined, at: Date, observedBalance: Money): void {
    this.assertNotTerminal(WagerTransactionStatus.Processed);
    if (this.requiresReference() && referenceTransactionId === undefined) {
      throw new InvalidWagerTransactionError(`${this.kind} só é processada com a referência resolvida`);
    }
    this.assertTransactionCurrency(observedBalance);
    this._status = WagerTransactionStatus.Processed;
    this._observedBalance = observedBalance;
    this._referenceTransactionId = referenceTransactionId;
    this._processedAt = at;
    this._nextReferenceCheckAt = undefined;
  }

  /**
   * Entra em PENDING_REFERENCE (vindo de PENDING) ou registra mais uma tentativa
   * (PENDING_REFERENCE → PENDING_REFERENCE). Incrementa as tentativas e agenda a próxima.
   */
  markPendingReference(now: Date): void {
    this.assertNotTerminal(WagerTransactionStatus.PendingReference);
    if (this.referenceExternalTransactionId === undefined) {
      throw new InvalidWagerTransactionError('transação sem referência não pode aguardar referência');
    }
    this._status = WagerTransactionStatus.PendingReference;
    this._referenceAttempts += 1;
    this._nextReferenceCheckAt = addMs(
      now,
      exponentialBackoffMs(this._referenceAttempts, REFERENCE_RETRY_BASE_MS, REFERENCE_RETRY_MAX_MS),
    );
  }

  /** `observedBalance` só quando há wallet na moeda da transação (ausente em WALLET_NOT_FOUND, por ex.). */
  reject(code: FailureCode, observedBalance?: Money): void {
    this.assertNotTerminal(WagerTransactionStatus.Rejected);
    if (observedBalance !== undefined) this.assertTransactionCurrency(observedBalance);
    this._status = WagerTransactionStatus.Rejected;
    this._failureCode = code;
    this._observedBalance = observedBalance;
    this._nextReferenceCheckAt = undefined;
  }

  fail(code: FailureCode): void {
    this.assertNotTerminal(WagerTransactionStatus.Failed);
    this._status = WagerTransactionStatus.Failed;
    this._failureCode = code;
    this._nextReferenceCheckAt = undefined;
  }

  isTerminal(): boolean {
    return TERMINAL.has(this._status);
  }

  /** false só para LOSS. */
  affectsBalance(): boolean {
    return this.kind !== WagerTransactionKind.Loss;
  }

  requiresReference(): boolean {
    return REVERSALS.has(this.kind);
  }

  /** REFUND ou ROLLBACK. */
  isReversal(): boolean {
    return REVERSALS.has(this.kind);
  }

  /**
   * O kind da referência é aceito para esta operação? REFUND, WIN e LOSS → BET;
   * ROLLBACK → BET, WIN ou REFUND. BET e OPENING não referenciam nada.
   */
  canReference(reference: WagerTransaction): boolean {
    return REFERENCEABLE[this.kind]?.has(reference.kind) ?? false;
  }

  matchesPayload(payloadHash: string): boolean {
    return this.payloadHash === payloadHash;
  }

  /** Direção do lançamento. ROLLBACK inverte a direção da referência (BET, WIN ou REFUND). */
  ledgerDirectionFor(reference?: WagerTransaction): LedgerDirection {
    switch (this.kind) {
      case WagerTransactionKind.Bet:
        return LedgerDirection.Debit;
      case WagerTransactionKind.Opening:
      case WagerTransactionKind.Win:
      case WagerTransactionKind.Refund:
        return LedgerDirection.Credit;
      case WagerTransactionKind.Loss:
        throw new InvalidWagerTransactionError('LOSS não movimenta saldo');
      case WagerTransactionKind.Rollback:
        if (reference === undefined || !this.canReference(reference)) {
          throw new InvalidWagerTransactionError('ROLLBACK exige referência BET, WIN ou REFUND');
        }
        return reference.ledgerDirectionFor() === LedgerDirection.Debit
          ? LedgerDirection.Credit
          : LedgerDirection.Debit;
    }
  }

  private assertTransactionCurrency(balance: Money): void {
    if (balance.currency !== this.money.currency) {
      throw new InvalidWagerTransactionError('o saldo observado deve estar na moeda da transação');
    }
  }

  private assertNotTerminal(attempted: WagerTransactionStatus): void {
    if (this.isTerminal()) {
      throw new InvalidTransactionStateError(this.id, this._status, attempted);
    }
  }
}
