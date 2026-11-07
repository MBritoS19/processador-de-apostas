import { describe, expect, test } from 'bun:test';
import { InvalidTransactionStateError } from '../../../src/domain/errors';
import { WagerTransactionPendingReference } from '../../../src/domain/events/wager-transaction-pending-reference';
import { WagerTransactionProcessed } from '../../../src/domain/events/wager-transaction-processed';
import { WagerTransactionRejected } from '../../../src/domain/events/wager-transaction-rejected';
import { WalletBalanceChanged } from '../../../src/domain/events/wallet-balance-changed';
import { FailureCode } from '../../../src/domain/failure-code';
import { Wallet } from '../../../src/domain/wallet';
import { WagerTransactionKind } from '../../../src/domain/wager-transaction';
import { T0, brl, newTransaction } from './fixtures';

const T1 = new Date('2026-11-07T12:00:01.000Z');
const ctx = { eventId: 'evt-1', correlationId: 'corr-1', causationId: 'msg-1', occurredAt: T1 };

function walletWithBet() {
  const { wallet } = Wallet.open({
    id: 'wallet-1',
    playerId: 'player-1',
    initialBalance: brl('100'),
    openingTransactionId: 'tx-open',
    openingEntryId: 'entry-0',
    at: T0,
  });
  const tx = newTransaction({ money: brl('25.5') });
  const entry = wallet.debit({ entryId: 'entry-1', transactionId: tx.id, money: tx.money, at: T1 });
  tx.markProcessed(undefined, T1);
  return { wallet, tx, entry };
}

/** Round-trip por JSON: o payload da outbox precisa ser JSON puro e estável. */
const roundTrip = (value: unknown) => JSON.parse(JSON.stringify(value));

describe('IntegrationEvent — envelope', () => {
  test('WalletBalanceChanged serializa envelope com MoneyProps e data ISO', () => {
    const { wallet, entry } = walletWithBet();
    const event = WalletBalanceChanged.from(wallet, entry, ctx);
    const json = event.toJSON();
    expect(roundTrip(json)).toEqual({
      eventId: 'evt-1',
      eventType: 'WalletBalanceChanged',
      aggregateId: 'wallet-1',
      correlationId: 'corr-1',
      causationId: 'msg-1',
      occurredAt: '2026-11-07T12:00:01.000Z',
      version: 1,
      data: {
        walletId: 'wallet-1',
        transactionId: 'tx-1',
        direction: 'DEBIT',
        money: { amount: '25.50', currency: 'BRL' },
        balanceBefore: { amount: '100.00', currency: 'BRL' },
        balanceAfter: { amount: '74.50', currency: 'BRL' },
        walletVersion: 2,
      },
    });
    expect(roundTrip(json)).toEqual(json);
  });

  test('causationId ausente não aparece no envelope', () => {
    const { wallet, entry } = walletWithBet();
    const json = WalletBalanceChanged.from(wallet, entry, { eventId: 'e', correlationId: 'c', occurredAt: T1 }).toJSON();
    expect('causationId' in json).toBe(false);
  });

  test('data é congelado', () => {
    const { wallet, entry } = walletWithBet();
    expect(Object.isFrozen(WalletBalanceChanged.from(wallet, entry, ctx).data)).toBe(true);
  });
});

describe('Eventos de transação', () => {
  test('WagerTransactionProcessed carrega o saldo do momento', () => {
    const { wallet, tx } = walletWithBet();
    const json = WagerTransactionProcessed.from(tx, wallet, ctx).toJSON();
    expect(json.eventType).toBe('WagerTransactionProcessed');
    expect(json.version).toBe(1);
    expect(json.aggregateId).toBe('tx-1');
    expect(json.data).toEqual({
      transactionId: 'tx-1',
      providerId: 'provider-1',
      externalTransactionId: 'ext-1',
      walletId: 'wallet-1',
      playerId: 'player-1',
      roundId: 'round-1',
      gameId: 'game-1',
      kind: WagerTransactionKind.Bet,
      money: { amount: '25.50', currency: 'BRL' },
      referenceTransactionId: null,
      balance: { amount: '74.50', currency: 'BRL' },
      walletVersion: 2,
      processedAt: '2026-11-07T12:00:01.000Z',
    });
    expect(roundTrip(json)).toEqual(json);
  });

  test('WagerTransactionRejected carrega o failureCode', () => {
    const tx = newTransaction();
    tx.reject(FailureCode.InsufficientBalance);
    const json = WagerTransactionRejected.from(tx, ctx).toJSON();
    expect(json.eventType).toBe('WagerTransactionRejected');
    expect(json.data.failureCode).toBe(FailureCode.InsufficientBalance);
    expect(json.data.money).toEqual({ amount: '10.00', currency: 'BRL' });
  });

  test('WagerTransactionPendingReference carrega referência e agendamento', () => {
    const tx = newTransaction({ kind: WagerTransactionKind.Refund, referenceExternalTransactionId: 'ext-bet' });
    tx.markPendingReference(T0);
    const json = WagerTransactionPendingReference.from(tx, ctx).toJSON();
    expect(json.eventType).toBe('WagerTransactionPendingReference');
    expect(json.data.referenceExternalTransactionId).toBe('ext-bet');
    expect(json.data.referenceAttempts).toBe(1);
    expect(json.data.nextReferenceCheckAt).toBe('2026-11-07T12:00:05.000Z');
  });

  test('evento exige o status correspondente', () => {
    const { wallet } = walletWithBet();
    const pending = newTransaction();
    expect(() => WagerTransactionProcessed.from(pending, wallet, ctx)).toThrow(InvalidTransactionStateError);
    expect(() => WagerTransactionRejected.from(pending, ctx)).toThrow(InvalidTransactionStateError);
    expect(() => WagerTransactionPendingReference.from(pending, ctx)).toThrow(InvalidTransactionStateError);
  });
});
