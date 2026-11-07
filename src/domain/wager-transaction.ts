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

/** Backoff entre tentativas de resolver a referência (o limite de tentativas é da Fase 7). */
export const REFERENCE_RETRY_BASE_MS = 5_000;
export const REFERENCE_RETRY_MAX_MS = 10 * 60_000;

const TERMINAL = new Set([
  WagerTransactionStatus.Processed,
  WagerTransactionStatus.Rejected,
  WagerTransactionStatus.Failed,
]);
const REQUIRES_REFERENCE = new Set([WagerTransactionKind.Refund, WagerTransactionKind.Rollback]);
const ROLLBACKABLE = new Set([WagerTransactionKind.Bet, WagerTransactionKind.Win, WagerTransactionKind.Refund]);

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
  }

  /** Nasce em PENDING. Rejeita OPENING e valida a exigência de referência e de valor por kind. */
  static create(props: CreateWagerTransactionProps): WagerTransaction {
    const { kind, money, referenceExternalTransactionId: reference } = props;
    if (kind === WagerTransactionKind.Opening) {
      throw new InvalidWagerTransactionError('OPENING é interno e não pode ser submetido');
    }
    if (REQUIRES_REFERENCE.has(kind) && (reference === undefined || reference.trim() === '')) {
      throw new InvalidWagerTransactionError(`${kind} exige referenceExternalTransactionId`);
    }
    if (kind === WagerTransactionKind.Loss ? money.isNegative() : !money.isPositive()) {
      throw new InvalidWagerTransactionError(`valor inválido para ${kind}`);
    }
    return new WagerTransaction({ ...props, status: WagerTransactionStatus.Pending, referenceAttempts: 0 });
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

  markProcessed(referenceTransactionId: string | undefined, at: Date): void {
    this.assertNotTerminal(WagerTransactionStatus.Processed);
    if (this.requiresReference() && referenceTransactionId === undefined) {
      throw new InvalidWagerTransactionError(`${this.kind} só é processada com a referência resolvida`);
    }
    this._status = WagerTransactionStatus.Processed;
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

  reject(code: FailureCode): void {
    this.assertNotTerminal(WagerTransactionStatus.Rejected);
    this._status = WagerTransactionStatus.Rejected;
    this._failureCode = code;
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
    return REQUIRES_REFERENCE.has(this.kind);
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
        if (reference === undefined || !ROLLBACKABLE.has(reference.kind)) {
          throw new InvalidWagerTransactionError('ROLLBACK exige referência BET, WIN ou REFUND');
        }
        return reference.ledgerDirectionFor() === LedgerDirection.Debit
          ? LedgerDirection.Credit
          : LedgerDirection.Debit;
    }
  }

  private assertNotTerminal(attempted: WagerTransactionStatus): void {
    if (this.isTerminal()) {
      throw new InvalidTransactionStateError(this.id, this._status, attempted);
    }
  }
}
