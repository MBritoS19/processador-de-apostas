import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import type { MikroORM } from '@mikro-orm/postgresql';
import { randomUUID } from 'node:crypto';
import { FailureCode } from '../../../src/domain/failure-code';
import { InboxMessage } from '../../../src/domain/inbox-message';
import { Money } from '../../../src/domain/money';
import { OutboxMessage } from '../../../src/domain/outbox-message';
import {
  WagerTransaction,
  WagerTransactionKind,
  WagerTransactionStatus,
} from '../../../src/domain/wager-transaction';
import { Wallet } from '../../../src/domain/wallet';
import { WalletBalanceChanged } from '../../../src/domain/events/wallet-balance-changed';
import {
  InboxMessageRecord,
  OutboxMessageRecord,
  toInboxMessage,
  toInboxMessageRecord,
  toOutboxMessage,
  toOutboxMessageRecord,
} from '../../../src/infrastructure/persistence/messages.persistence';
import {
  WagerTransactionRecord,
  toWagerTransaction,
  toWagerTransactionRecord,
} from '../../../src/infrastructure/persistence/wager-transaction.persistence';
import {
  LedgerEntryRecord,
  toLedgerEntry,
  toLedgerEntryRecord,
} from '../../../src/infrastructure/persistence/wallet-ledger-entry.persistence';
import { WalletRecord, toWallet, toWalletRecord } from '../../../src/infrastructure/persistence/wallet.persistence';
import { T0, openOrm, truncateAll } from './db';

const T1 = new Date('2026-11-07T12:05:00.123Z');
const brl = (amount: string) => Money.from({ amount, currency: 'BRL' });

/** Domínio → record → Postgres → record → domínio, com Money exato (sem passar por number). */
describe('persistência — round-trip pelo MikroORM', () => {
  let orm: MikroORM;

  beforeAll(async () => {
    orm = await openOrm();
  });

  beforeEach(async () => {
    await truncateAll(orm);
  });

  afterAll(async () => {
    await orm.close(true);
  });

  function openingTransaction(wallet: Wallet, id: string): WagerTransaction {
    // OPENING ainda não tem factory própria (Fase 4): reconstruído direto no estado final.
    return WagerTransaction.rehydrate({
      id,
      providerId: 'internal',
      externalTransactionId: `opening:${wallet.id}`,
      idempotencyKey: `opening:${wallet.id}`,
      payloadHash: 'opening',
      walletId: wallet.id,
      playerId: wallet.playerId,
      roundId: 'opening',
      gameId: 'opening',
      kind: WagerTransactionKind.Opening,
      money: wallet.balance,
      createdAt: T0,
      status: WagerTransactionStatus.Processed,
      processedAt: T0,
      observedBalance: wallet.balance,
      referenceAttempts: 0,
    });
  }

  /** Abre a wallet e aplica uma BET, gravando tudo num único flush (a ordem não importa: FKs deferidas). */
  async function openAndBet(initial: string, bet: string) {
    const openingId = randomUUID();
    const { wallet, openingEntry } = Wallet.open({
      id: randomUUID(),
      playerId: `player-${randomUUID()}`,
      initialBalance: brl(initial),
      openingTransactionId: openingId,
      openingEntryId: randomUUID(),
      at: T0,
    });
    const opening = openingTransaction(wallet, openingId);

    const betTx = WagerTransaction.create({
      id: randomUUID(),
      providerId: 'provider-a',
      externalTransactionId: 'bet-1',
      idempotencyKey: 'provider-a:bet-1',
      payloadHash: 'hash-bet-1',
      walletId: wallet.id,
      playerId: wallet.playerId,
      roundId: 'round-1',
      gameId: 'game-1',
      kind: WagerTransactionKind.Bet,
      money: brl(bet),
      createdAt: T1,
    });
    const betEntry = wallet.debit({ entryId: randomUUID(), transactionId: betTx.id, money: betTx.money, at: T1 });
    betTx.markProcessed(undefined, T1, wallet.balance);

    if (!openingEntry) throw new Error('saldo inicial deve gerar lançamento');
    const em = orm.em.fork();
    // Lançamentos persistidos antes da transação e da wallet de propósito.
    em.persist([toLedgerEntryRecord(openingEntry), toLedgerEntryRecord(betEntry)]);
    em.persist([toWagerTransactionRecord(betTx), toWagerTransactionRecord(opening), toWalletRecord(wallet)]);
    await em.flush();

    return { wallet, opening, betTx, openingEntry, betEntry };
  }

  it.each([
    ['99999999999999.99', '0.10', '99999999999999.89'],
    ['0.10', '0.10', '0.00'],
    ['1000.00', '25.50', '974.50'],
  ])('wallet %s, BET %s → saldo %s, exato no banco e no domínio', async (initial, bet, expected) => {
    const saved = await openAndBet(initial, bet);
    const em = orm.em.fork();

    const wallet = toWallet(await em.findOneOrFail(WalletRecord, { id: saved.wallet.id }));
    expect(wallet).toEqual(saved.wallet);
    expect(wallet.balance.amount).toBe(expected);
    expect(wallet.version).toBe(2);

    const betTx = toWagerTransaction(await em.findOneOrFail(WagerTransactionRecord, { id: saved.betTx.id }));
    expect(betTx).toEqual(saved.betTx);
    expect(betTx.money.amount).toBe(brl(bet).amount);
    expect(betTx.observedBalance?.amount).toBe(expected);
    expect(toWagerTransaction(await em.findOneOrFail(WagerTransactionRecord, { id: saved.opening.id }))).toEqual(
      saved.opening,
    );

    const entries = await em.find(LedgerEntryRecord, { walletId: wallet.id }, { orderBy: { createdAt: 'asc' } });
    expect(entries.map(toLedgerEntry)).toEqual([saved.openingEntry, saved.betEntry]);
    expect(entries.map((e) => toLedgerEntry(e).isBalanced())).toEqual([true, true]);

    // A coluna numeric guarda exatamente a mesma string.
    const [raw] = await em.getKnex().raw<{ rows: Array<{ balance: string }> }>(
      'select balance::text as balance from wallets where id = ?',
      [wallet.id],
    ).then((r) => r.rows);
    expect(raw?.balance).toBe(expected);
  });

  it('transação PENDING_REFERENCE e REJECTED sem saldo observado preservam opcionais nulos', async () => {
    const { wallet } = await openAndBet('100.00', '10.00');
    const base = {
      providerId: 'provider-a',
      walletId: wallet.id,
      playerId: wallet.playerId,
      roundId: 'round-1',
      gameId: 'game-1',
      payloadHash: 'h',
      money: brl('10.00'),
      createdAt: T1,
    };
    const pending = WagerTransaction.create({
      ...base,
      id: randomUUID(),
      externalTransactionId: 'refund-1',
      idempotencyKey: 'provider-a:refund-1',
      kind: WagerTransactionKind.Refund,
      referenceExternalTransactionId: 'bet-unknown',
    });
    pending.markPendingReference(T1);
    const rejected = WagerTransaction.create({
      ...base,
      id: randomUUID(),
      walletId: randomUUID(),
      externalTransactionId: 'bet-2',
      idempotencyKey: 'provider-a:bet-2',
      kind: WagerTransactionKind.Bet,
    });
    rejected.reject(FailureCode.WalletNotFound);

    const em = orm.em.fork();
    em.persist([toWagerTransactionRecord(pending), toWagerTransactionRecord(rejected)]);
    await em.flush();

    const read = orm.em.fork();
    const loadedPending = toWagerTransaction(await read.findOneOrFail(WagerTransactionRecord, { id: pending.id }));
    expect(loadedPending).toEqual(pending);
    expect(loadedPending.referenceAttempts).toBe(1);
    const loadedRejected = toWagerTransaction(await read.findOneOrFail(WagerTransactionRecord, { id: rejected.id }));
    expect(loadedRejected).toEqual(rejected);
    expect(loadedRejected.observedBalance).toBeUndefined();
  });

  it('inbox e outbox (payload jsonb) voltam iguais', async () => {
    const inbox = InboxMessage.receive({ messageId: 'sqs-1', consumerName: 'wager-consumer', payloadHash: 'h', receivedAt: T0 });
    inbox.markProcessed(T1);
    const { wallet, betEntry } = await openAndBet('99999999999999.99', '0.10');
    const event = WalletBalanceChanged.from(wallet, betEntry, { eventId: randomUUID(), correlationId: 'corr-1', occurredAt: T1 });
    const outbox = OutboxMessage.enqueue(event);
    outbox.scheduleRetry(T1);

    const em = orm.em.fork();
    em.persist([toInboxMessageRecord(inbox), toOutboxMessageRecord(outbox)]);
    await em.flush();

    const read = orm.em.fork();
    expect(
      toInboxMessage(await read.findOneOrFail(InboxMessageRecord, { consumerName: 'wager-consumer', messageId: 'sqs-1' })),
    ).toEqual(inbox);
    const loaded = toOutboxMessage(await read.findOneOrFail(OutboxMessageRecord, { id: outbox.id }));
    expect(loaded.payload).toEqual(outbox.payload);
    expect(loaded.attempts).toBe(1);
    expect(loaded.nextAttemptAt).toEqual(outbox.nextAttemptAt);
  });
});
