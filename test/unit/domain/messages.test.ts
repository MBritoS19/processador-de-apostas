import { describe, expect, test } from 'bun:test';
import { exponentialBackoffMs } from '../../../src/domain/backoff';
import { InvalidMessageStateError } from '../../../src/domain/errors';
import { WalletBalanceChanged } from '../../../src/domain/events/wallet-balance-changed';
import { InboxMessage } from '../../../src/domain/inbox-message';
import { OUTBOX_RETRY_BASE_MS, OUTBOX_RETRY_MAX_MS, OutboxMessage } from '../../../src/domain/outbox-message';
import { Wallet } from '../../../src/domain/wallet';
import { T0, brl } from './fixtures';

const at = (ms: number) => new Date(T0.getTime() + ms);

function enqueue(): OutboxMessage {
  const { wallet, openingEntry } = Wallet.open({
    id: 'wallet-1',
    playerId: 'player-1',
    initialBalance: brl('10.00'),
    openingTransactionId: 'tx-open',
    openingEntryId: 'entry-1',
    at: T0,
  });
  if (!openingEntry) throw new Error('fixture sem lançamento');
  const event = WalletBalanceChanged.from(wallet, openingEntry, { eventId: 'evt-1', correlationId: 'corr-1', occurredAt: T0 });
  return OutboxMessage.enqueue(event);
}

describe('exponentialBackoffMs', () => {
  test('dobra a cada tentativa e respeita o teto', () => {
    expect([1, 2, 3, 4].map((n) => exponentialBackoffMs(n, 1000, 5000))).toEqual([1000, 2000, 4000, 5000]);
    expect(exponentialBackoffMs(10_000, 1000, 5000)).toBe(5000);
  });

  test.each([0, -1, 1.5])('rejeita attempt %p', (attempt) => {
    expect(() => exponentialBackoffMs(attempt, 1000, 5000)).toThrow(RangeError);
  });
});

describe('InboxMessage', () => {
  test('nasce não processada e é marcada uma única vez', () => {
    const msg = InboxMessage.receive({ messageId: 'm-1', consumerName: 'wager', payloadHash: 'h', receivedAt: T0 });
    expect(msg.isProcessed()).toBe(false);
    msg.markProcessed(at(1));
    expect(msg.isProcessed()).toBe(true);
    expect(msg.processedAt).toEqual(at(1));
    expect(() => msg.markProcessed(at(2))).toThrow(InvalidMessageStateError);
  });

  test('rehydrate preserva o processamento', () => {
    const msg = InboxMessage.rehydrate({ messageId: 'm-1', consumerName: 'wager', payloadHash: 'h', receivedAt: T0, processedAt: at(5) });
    expect(msg.isProcessed()).toBe(true);
  });
});

describe('OutboxMessage', () => {
  test('enqueue usa o eventId como id e grava o envelope serializado', () => {
    const msg = enqueue();
    expect(msg.id).toBe('evt-1');
    expect(msg.aggregateId).toBe('wallet-1');
    expect(msg.eventType).toBe('WalletBalanceChanged');
    expect(msg.payload['eventType']).toBe('WalletBalanceChanged');
    expect(msg.attempts).toBe(0);
    expect(msg.isPending()).toBe(true);
    expect(msg.isDue(T0)).toBe(true);
  });

  test('scheduleRetry aplica backoff exponencial com teto', () => {
    const msg = enqueue();
    const delays: number[] = [];
    for (let i = 0; i < 12; i++) {
      msg.scheduleRetry(T0);
      delays.push((msg.nextAttemptAt?.getTime() ?? 0) - T0.getTime());
    }
    expect(delays.slice(0, 4)).toEqual([1, 2, 4, 8].map((n) => n * OUTBOX_RETRY_BASE_MS));
    expect(delays.at(-1)).toBe(OUTBOX_RETRY_MAX_MS);
    expect(delays.every((d, i) => i === 0 || d >= (delays[i - 1] ?? 0))).toBe(true);
    expect(msg.attempts).toBe(12);
  });

  test('isDue respeita nextAttemptAt', () => {
    const msg = enqueue();
    msg.scheduleRetry(T0);
    expect(msg.isDue(at(OUTBOX_RETRY_BASE_MS - 1))).toBe(false);
    expect(msg.isDue(at(OUTBOX_RETRY_BASE_MS))).toBe(true);
  });

  test('publicada é terminal: não fica due, não republica nem reagenda', () => {
    const msg = enqueue();
    msg.markPublished(at(1));
    expect(msg.isPending()).toBe(false);
    expect(msg.isDue(at(1_000_000))).toBe(false);
    expect(msg.publishedAt).toEqual(at(1));
    expect(() => msg.markPublished(at(2))).toThrow(InvalidMessageStateError);
    expect(() => msg.scheduleRetry(at(2))).toThrow(InvalidMessageStateError);
  });

  test('rehydrate preserva tentativas e agendamento', () => {
    const msg = OutboxMessage.rehydrate({
      id: 'evt-9',
      aggregateId: 'a',
      eventType: 'X',
      payload: {},
      occurredAt: T0,
      attempts: 3,
      nextAttemptAt: at(10),
    });
    expect(msg.attempts).toBe(3);
    expect(msg.isDue(at(9))).toBe(false);
  });
});
