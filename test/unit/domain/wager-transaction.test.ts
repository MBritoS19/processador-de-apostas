import { describe, expect, test } from 'bun:test';
import { InvalidTransactionStateError, InvalidWagerTransactionError } from '../../../src/domain/errors';
import { FailureCode } from '../../../src/domain/failure-code';
import {
  REFERENCE_RETRY_BASE_MS,
  REFERENCE_RETRY_MAX_MS,
  WagerTransaction,
  WagerTransactionKind as Kind,
  WagerTransactionStatus as Status,
} from '../../../src/domain/wager-transaction';
import { Money } from '../../../src/domain/money';
import { LedgerDirection } from '../../../src/domain/wallet-ledger-entry';
import { T0, brl, newTransaction } from './fixtures';

const T1 = new Date('2026-11-07T12:05:00.000Z');
const withRef = (kind: Kind) => newTransaction({ kind, referenceExternalTransactionId: 'ext-ref' });

describe('WagerTransaction.create', () => {
  test('nasce em PENDING, sem tentativas de referência', () => {
    const tx = newTransaction();
    expect(tx.status).toBe(Status.Pending);
    expect(tx.isTerminal()).toBe(false);
    expect(tx.referenceAttempts).toBe(0);
    expect(tx.nextReferenceCheckAt).toBeUndefined();
    expect(tx.failureCode).toBeUndefined();
    expect(tx.processedAt).toBeUndefined();
  });

  test('OPENING é interno e não pode ser criado', () => {
    expect(() => newTransaction({ kind: Kind.Opening })).toThrow(InvalidWagerTransactionError);
  });

  test.each([Kind.Refund, Kind.Rollback])('%s exige referência', (kind) => {
    expect(() => newTransaction({ kind })).toThrow(InvalidWagerTransactionError);
    expect(() => newTransaction({ kind, referenceExternalTransactionId: '  ' })).toThrow(InvalidWagerTransactionError);
    expect(withRef(kind).referenceExternalTransactionId).toBe('ext-ref');
  });

  test.each([Kind.Bet, Kind.Win, Kind.Loss])('%s não exige referência', (kind) => {
    expect(newTransaction({ kind }).requiresReference()).toBe(false);
  });

  test.each([Kind.Bet, Kind.Win])('%s com valor zero é inválida', (kind) => {
    expect(() => newTransaction({ kind, money: brl('0') })).toThrow(InvalidWagerTransactionError);
  });

  test('LOSS aceita valor zero', () => {
    expect(newTransaction({ kind: Kind.Loss, money: brl('0') }).status).toBe(Status.Pending);
  });
});

describe('WagerTransaction — transições válidas', () => {
  test('PENDING → PROCESSED', () => {
    const tx = newTransaction();
    tx.markProcessed(undefined, T1, brl('90.00'));
    expect(tx.status).toBe(Status.Processed);
    expect(tx.processedAt).toEqual(T1);
    expect(tx.observedBalance).toEqual(brl('90.00'));
    expect(tx.isTerminal()).toBe(true);
  });

  test('PENDING → REJECTED com failureCode', () => {
    const tx = newTransaction();
    tx.reject(FailureCode.InsufficientBalance);
    expect(tx.status).toBe(Status.Rejected);
    expect(tx.failureCode).toBe(FailureCode.InsufficientBalance);
    expect(tx.processedAt).toBeUndefined();
    expect(tx.observedBalance).toBeUndefined();
  });

  test('REJECTED guarda o saldo observado, quando informado', () => {
    const tx = newTransaction();
    tx.reject(FailureCode.InsufficientBalance, brl('5.00'));
    expect(tx.observedBalance).toEqual(brl('5.00'));
  });

  test('saldo observado em outra moeda é inválido e não muda o estado', () => {
    const usd = Money.from({ amount: '5.00', currency: 'USD' });
    const tx = newTransaction();
    expect(() => tx.markProcessed(undefined, T1, usd)).toThrow(InvalidWagerTransactionError);
    expect(() => tx.reject(FailureCode.InsufficientBalance, usd)).toThrow(InvalidWagerTransactionError);
    expect(tx.status).toBe(Status.Pending);
  });

  test('PENDING → FAILED com failureCode', () => {
    const tx = newTransaction();
    tx.fail(FailureCode.InfrastructureFailure);
    expect(tx.status).toBe(Status.Failed);
    expect(tx.failureCode).toBe(FailureCode.InfrastructureFailure);
  });

  test('PENDING → PENDING_REFERENCE → PENDING_REFERENCE com backoff exponencial', () => {
    const tx = withRef(Kind.Refund);
    tx.markPendingReference(T0);
    expect(tx.status).toBe(Status.PendingReference);
    expect(tx.referenceAttempts).toBe(1);
    expect(tx.nextReferenceCheckAt).toEqual(new Date(T0.getTime() + REFERENCE_RETRY_BASE_MS));

    tx.markPendingReference(T0);
    expect(tx.referenceAttempts).toBe(2);
    expect(tx.nextReferenceCheckAt).toEqual(new Date(T0.getTime() + 2 * REFERENCE_RETRY_BASE_MS));

    for (let i = 0; i < 20; i++) tx.markPendingReference(T0);
    expect(tx.referenceAttempts).toBe(22);
    expect(tx.nextReferenceCheckAt).toEqual(new Date(T0.getTime() + REFERENCE_RETRY_MAX_MS));
  });

  test('PENDING_REFERENCE → PROCESSED guarda a referência interna e limpa o agendamento', () => {
    const tx = withRef(Kind.Rollback);
    tx.markPendingReference(T0);
    tx.markProcessed('tx-ref', T1, brl('90.00'));
    expect(tx.status).toBe(Status.Processed);
    expect(tx.referenceTransactionId).toBe('tx-ref');
    expect(tx.nextReferenceCheckAt).toBeUndefined();
  });

  test('PENDING_REFERENCE → REJECTED quando a referência não aparece', () => {
    const tx = withRef(Kind.Refund);
    tx.markPendingReference(T0);
    tx.reject(FailureCode.ReferenceNotFound);
    expect(tx.status).toBe(Status.Rejected);
    expect(tx.nextReferenceCheckAt).toBeUndefined();
  });
});

describe('WagerTransaction — transições inválidas', () => {
  const terminals: Array<[string, (tx: WagerTransaction) => void]> = [
    ['PROCESSED', (tx) => tx.markProcessed('tx-ref', T1, brl('90.00'))],
    ['REJECTED', (tx) => tx.reject(FailureCode.AmountMismatch)],
    ['FAILED', (tx) => tx.fail(FailureCode.InfrastructureFailure)],
  ];
  const attempts: Array<[string, (tx: WagerTransaction) => void]> = [
    ['markProcessed', (tx) => tx.markProcessed('tx-ref', T1, brl('90.00'))],
    ['markPendingReference', (tx) => tx.markPendingReference(T1)],
    ['reject', (tx) => tx.reject(FailureCode.AmountMismatch)],
    ['fail', (tx) => tx.fail(FailureCode.InfrastructureFailure)],
  ];

  for (const [terminal, reach] of terminals) {
    for (const [name, attempt] of attempts) {
      test(`${terminal} não aceita ${name}`, () => {
        const tx = withRef(Kind.Refund);
        reach(tx);
        const before = { status: tx.status, failureCode: tx.failureCode };
        expect(() => attempt(tx)).toThrow(InvalidTransactionStateError);
        expect({ status: tx.status, failureCode: tx.failureCode }).toEqual(before);
      });
    }
  }

  test('REFUND/ROLLBACK não são processados sem a referência interna', () => {
    expect(() => withRef(Kind.Refund).markProcessed(undefined, T1, brl('90.00'))).toThrow(InvalidWagerTransactionError);
  });

  test('transação sem referência não vai para PENDING_REFERENCE', () => {
    expect(() => newTransaction().markPendingReference(T0)).toThrow(InvalidWagerTransactionError);
  });
});

describe('WagerTransaction — consultas', () => {
  test('affectsBalance é false só para LOSS', () => {
    expect(newTransaction({ kind: Kind.Loss }).affectsBalance()).toBe(false);
    for (const kind of [Kind.Bet, Kind.Win]) expect(newTransaction({ kind }).affectsBalance()).toBe(true);
    for (const kind of [Kind.Refund, Kind.Rollback]) expect(withRef(kind).affectsBalance()).toBe(true);
  });

  test('matchesPayload compara o hash (mesma key, payload diferente = conflito)', () => {
    const tx = newTransaction({ payloadHash: 'abc' });
    expect(tx.matchesPayload('abc')).toBe(true);
    expect(tx.matchesPayload('xyz')).toBe(false);
  });

  test('ledgerDirectionFor de kinds com direção fixa', () => {
    expect(newTransaction({ kind: Kind.Bet }).ledgerDirectionFor()).toBe(LedgerDirection.Debit);
    expect(newTransaction({ kind: Kind.Win }).ledgerDirectionFor()).toBe(LedgerDirection.Credit);
    expect(withRef(Kind.Refund).ledgerDirectionFor()).toBe(LedgerDirection.Credit);
    expect(() => newTransaction({ kind: Kind.Loss }).ledgerDirectionFor()).toThrow(InvalidWagerTransactionError);
  });

  test.each([
    [Kind.Bet, LedgerDirection.Credit],
    [Kind.Win, LedgerDirection.Debit],
    [Kind.Refund, LedgerDirection.Debit],
  ])('ROLLBACK de %s inverte para %s', (refKind, expected) => {
    const reference = refKind === Kind.Refund ? withRef(refKind) : newTransaction({ kind: refKind });
    expect(withRef(Kind.Rollback).ledgerDirectionFor(reference)).toBe(expected);
  });

  test('isReversal só para REFUND e ROLLBACK', () => {
    expect(withRef(Kind.Refund).isReversal()).toBe(true);
    expect(withRef(Kind.Rollback).isReversal()).toBe(true);
    for (const kind of [Kind.Bet, Kind.Win, Kind.Loss]) expect(newTransaction({ kind }).isReversal()).toBe(false);
  });

  test.each([
    [Kind.Refund, [Kind.Bet]],
    [Kind.Win, [Kind.Bet]],
    [Kind.Loss, [Kind.Bet]],
    [Kind.Rollback, [Kind.Bet, Kind.Win, Kind.Refund]],
    [Kind.Bet, []],
  ])('canReference: %s aceita %p', (kind, accepted) => {
    const tx = kind === Kind.Refund || kind === Kind.Rollback ? withRef(kind) : newTransaction({ kind });
    for (const refKind of [Kind.Bet, Kind.Win, Kind.Loss, Kind.Refund, Kind.Rollback]) {
      const reference = refKind === Kind.Refund || refKind === Kind.Rollback ? withRef(refKind) : newTransaction({ kind: refKind });
      expect(tx.canReference(reference)).toBe(accepted.includes(refKind));
    }
  });

  test('ROLLBACK sem referência ou de LOSS/ROLLBACK lança erro', () => {
    const rollback = withRef(Kind.Rollback);
    expect(() => rollback.ledgerDirectionFor()).toThrow(InvalidWagerTransactionError);
    expect(() => rollback.ledgerDirectionFor(newTransaction({ kind: Kind.Loss }))).toThrow(InvalidWagerTransactionError);
    expect(() => rollback.ledgerDirectionFor(withRef(Kind.Rollback))).toThrow(InvalidWagerTransactionError);
  });
});

describe('WagerTransaction.rehydrate', () => {
  test('reconstrói estado terminal e OPENING sem revalidar', () => {
    const tx = WagerTransaction.rehydrate({
      id: 'tx-open',
      providerId: 'internal',
      externalTransactionId: 'opening-1',
      idempotencyKey: 'opening-1',
      payloadHash: 'h',
      walletId: 'wallet-1',
      playerId: 'player-1',
      roundId: 'n/a',
      gameId: 'n/a',
      kind: Kind.Opening,
      money: brl('1000.00'),
      createdAt: T0,
      status: Status.Processed,
      processedAt: T0,
      referenceAttempts: 0,
    });
    expect(tx.kind).toBe(Kind.Opening);
    expect(tx.status).toBe(Status.Processed);
    expect(tx.ledgerDirectionFor()).toBe(LedgerDirection.Credit);
    expect(() => tx.reject(FailureCode.AmountMismatch)).toThrow(InvalidTransactionStateError);
  });
});
