import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import type { MikroORM } from '@mikro-orm/postgresql';
import { randomUUID } from 'node:crypto';
import { JournalEntry } from '../../../src/domain/journal-entry';
import { Money } from '../../../src/domain/money';
import {
  INTERNAL_PROVIDER_ID,
  WagerTransaction,
  WagerTransactionKind,
} from '../../../src/domain/wager-transaction';
import { Wallet } from '../../../src/domain/wallet';
import { LedgerDirection } from '../../../src/domain/wallet-ledger-entry';
import { MikroOrmWagerUnitOfWork } from '../../../src/infrastructure/persistence/mikro-orm-wager-unit-of-work';
import { PG, T0, expectPgError, openOrm, seedWallet, truncateAll } from './db';

const brl = (amount: string) => Money.from({ amount, currency: 'BRL' });

/** Adaptador do diário (`insertJournalEntry`) contra o Postgres real. */
describe('persistência — diário de partidas dobradas', () => {
  let orm: MikroORM;
  let uow: MikroOrmWagerUnitOfWork;
  const db = () => orm.em.getKnex();

  beforeAll(async () => {
    orm = await openOrm();
    uow = new MikroOrmWagerUnitOfWork(orm.em);
  });

  beforeEach(async () => {
    await truncateAll(orm);
  });

  afterAll(async () => {
    await orm.close(true);
  });

  /** BET PROCESSED gravada como o settlement grava: transação, saldo, ledger e diário. */
  function bet(walletId: string, playerId: string, providerId = 'provider-a', amount = '10.00', journal?: (tx: WagerTransaction, entry: JournalEntry) => JournalEntry) {
    return uow.run(async (repository) => {
      const wallet = (await repository.lockWallet(walletId, playerId))!;
      const version = wallet.version;
      const external = `ext-${randomUUID()}`;
      const tx = WagerTransaction.create({
        id: randomUUID(),
        providerId,
        externalTransactionId: external,
        idempotencyKey: external,
        payloadHash: 'hash',
        walletId,
        playerId,
        roundId: 'round-1',
        gameId: 'game-1',
        kind: WagerTransactionKind.Bet,
        money: brl(amount),
        createdAt: T0,
      });
      const ledger = wallet.debit({ entryId: randomUUID(), transactionId: tx.id, money: tx.money, at: T0 });
      tx.markProcessed(undefined, T0, wallet.balance);
      await repository.insertTransaction(tx);
      await repository.updateWallet(wallet, version);
      await repository.insertLedgerEntry(ledger);
      const entry = JournalEntry.forTransaction(randomUUID(), tx, ledger);
      await repository.insertJournalEntry(journal ? journal(tx, entry) : entry);
      return tx.id;
    });
  }

  const accounts = () => db()('accounts').orderBy(['kind', 'currency']).select('id', 'kind', 'wallet_id', 'provider_id', 'currency');
  const count = async (table: string) => Number((await db()(table).count<{ count: string }[]>('* as count'))[0]!.count);

  it('grava lançamento e pernas; cria PLAYER e HOUSE no primeiro uso e reaproveita depois', async () => {
    const { walletId, playerId } = await seedWallet(orm, '100.00');
    const first = await bet(walletId, playerId);
    await bet(walletId, playerId, 'provider-a', '15.50');

    const rows = await accounts();
    expect(rows.map((row) => [row.kind, row.wallet_id, row.provider_id, row.currency])).toEqual([
      ['PLAYER', walletId, null, 'BRL'],
      ['PROVIDER_HOUSE', null, 'provider-a', 'BRL'],
    ]);
    expect(await count('journal_entries')).toBe(2);

    const legs = await db()('journal_postings as p')
      .join('journal_entries as j', 'j.id', 'p.journal_entry_id')
      .join('accounts as a', 'a.id', 'p.account_id')
      .where('j.wager_transaction_id', first)
      .orderBy('p.direction')
      .select('a.kind', 'p.direction', db().raw('p.amount::text as amount'), 'p.currency');
    expect(legs).toEqual([
      { kind: 'PROVIDER_HOUSE', direction: 'CREDIT', amount: '10.00', currency: 'BRL' },
      { kind: 'PLAYER', direction: 'DEBIT', amount: '10.00', currency: 'BRL' },
    ]);
  });

  it('OPENING em moeda sem FUNDING cria a FUNDING sob demanda', async () => {
    const eur = (amount: string) => Money.from({ amount, currency: 'EUR' });
    const walletId = randomUUID();
    const openingId = randomUUID();
    const { wallet, openingEntry } = Wallet.open({
      id: walletId,
      playerId: `player-${randomUUID()}`,
      initialBalance: eur('40.00'),
      openingTransactionId: openingId,
      openingEntryId: randomUUID(),
      at: T0,
    });
    const opening = WagerTransaction.opening({
      id: openingId,
      providerId: INTERNAL_PROVIDER_ID,
      externalTransactionId: `opening:${walletId}`,
      idempotencyKey: `opening:${walletId}`,
      payloadHash: 'hash',
      walletId,
      playerId: wallet.playerId,
      roundId: 'opening',
      gameId: 'system',
      kind: WagerTransactionKind.Opening,
      money: eur('40.00'),
      createdAt: T0,
    });
    await uow.run(async (repository) => {
      await repository.insertWallet(wallet);
      await repository.insertTransaction(opening);
      await repository.insertLedgerEntry(openingEntry!);
      await repository.insertJournalEntry(JournalEntry.forTransaction(randomUUID(), opening, openingEntry!));
    });

    const rows = await accounts();
    expect(rows.map((row) => [row.kind, row.currency])).toEqual([
      ['FUNDING', 'EUR'],
      ['PLAYER', 'EUR'],
    ]);
  });

  describe('primeiro uso concorrente de uma HOUSE', () => {
    /** Outra transação cria a HOUSE e segura o commit até `release`. */
    async function holdHouse(providerId: string) {
      let release!: (commit: boolean) => void;
      const decided = new Promise<boolean>((resolve) => (release = resolve));
      const houseId = randomUUID();
      let inserted!: () => void;
      const ready = new Promise<void>((resolve) => (inserted = resolve));
      const holder = db()
        .transaction(async (trx) => {
          await trx('accounts').insert({ id: houseId, kind: 'PROVIDER_HOUSE', provider_id: providerId, currency: 'BRL', created_at: T0 });
          inserted();
          if (!(await decided)) throw new Error('rollback do holder');
        })
        .catch((error: Error) => {
          if (error.message !== 'rollback do holder') throw error;
        });
      await ready;
      return { houseId, release, holder };
    }

    async function waitForLockWait(): Promise<void> {
      for (let i = 0; i < 100; i++) {
        const { rows } = await db().raw(`select 1 from pg_stat_activity where wait_event_type = 'Lock' and query ilike '%insert into accounts%'`);
        if (rows.length > 0) return;
        await Bun.sleep(20);
      }
      throw new Error('o INSERT da HOUSE não chegou a esperar o holder');
    }

    it('espera o INSERT concorrente e reaproveita a conta que ele criou', async () => {
      const { walletId, playerId } = await seedWallet(orm, '100.00');
      const { houseId, release, holder } = await holdHouse('provider-new');
      const pending = bet(walletId, playerId, 'provider-new');
      await waitForLockWait();
      release(true);
      await holder;
      await pending;

      const houses = (await accounts()).filter((row) => row.kind === 'PROVIDER_HOUSE');
      expect(houses.map((row) => row.id)).toEqual([houseId]);
    });

    it('se o INSERT concorrente desiste, cria a própria conta', async () => {
      const { walletId, playerId } = await seedWallet(orm, '100.00');
      const { houseId, release, holder } = await holdHouse('provider-new');
      const pending = bet(walletId, playerId, 'provider-new');
      await waitForLockWait();
      release(false);
      await holder;
      await pending;

      const houses = (await accounts()).filter((row) => row.kind === 'PROVIDER_HOUSE');
      expect(houses).toHaveLength(1);
      expect(houses[0]!.id).not.toBe(houseId);
    });
  });

  it('lançamento desbalanceado derruba a transação SQL inteira no COMMIT', async () => {
    const { walletId, playerId } = await seedWallet(orm, '100.00');
    const unbalanced = (tx: WagerTransaction, entry: JournalEntry) =>
      JournalEntry.rehydrate({
        id: entry.id,
        transactionId: tx.id,
        currency: 'BRL',
        createdAt: T0,
        postings: [entry.postings[0]!, { ...entry.postings[1]!, direction: LedgerDirection.Credit, money: brl('9.99') }],
      });

    await expectPgError(bet(walletId, playerId, 'provider-a', '10.00', unbalanced), PG.checkViolation, 'trg_journal_balanced');

    expect(await count('journal_entries')).toBe(0);
    expect(await count('journal_postings')).toBe(0);
    expect(await count('accounts')).toBe(0);
    expect(await db()('wager_transactions').where({ kind: 'BET' }).count<{ count: string }[]>('* as count')).toEqual([{ count: '0' }]);
    expect(await count('wallet_ledger_entries')).toBe(1); // só o OPENING do seed
    const wallet = await db()('wallets').where({ id: walletId }).first<{ balance: string; version: number }>();
    expect(wallet).toMatchObject({ balance: '100.00', version: 1 });
  });
});
