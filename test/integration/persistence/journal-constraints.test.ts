import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import type { Knex, MikroORM } from '@mikro-orm/postgresql';
import { randomUUID } from 'node:crypto';
import {
  PG,
  T0,
  accountId,
  expectPgError,
  insertJournal,
  ledgerRow,
  openOrm,
  processed,
  seedWallet,
  standardPostings,
  transactionRow,
  truncateAll,
  walletRow,
  type JournalPostingSeed,
} from './db';

const BALANCED = 'trg_journal_balanced';
const PROVIDER = 'provider-a';

/** Garantias do diário de partidas dobradas provadas contra o Postgres real. */
describe('schema — diário de partidas dobradas', () => {
  let orm: MikroORM;
  const db = () => orm.em.getKnex();

  beforeAll(async () => {
    orm = await openOrm();
  });

  beforeEach(async () => {
    await truncateAll(orm);
  });

  afterAll(async () => {
    await orm.close(true);
  });

  /** Wallet de 100 com uma BET de 10 PROCESSED e o lançamento DEBIT (100 → 90), sem diário. */
  async function walletWithBet(): Promise<{ walletId: string; playerId: string; betId: string; openingId: string }> {
    const wallet = await seedWallet(orm, '100.00');
    const bet = processed({ wallet_id: wallet.walletId, player_id: wallet.playerId, kind: 'BET', observed_balance: '90.00' });
    await db().transaction(async (trx) => {
      await trx('wager_transactions').insert(bet);
      await trx('wallet_ledger_entries').insert(
        ledgerRow({
          wallet_id: wallet.walletId,
          transaction_id: bet.id as string,
          direction: 'DEBIT',
          balance_before: '100.00',
          balance_after: '90.00',
        }),
      );
      await trx('wallets').where({ id: wallet.walletId }).update({ balance: '90.00', version: 2 });
    });
    return { ...wallet, betId: bet.id as string };
  }

  const betPostings = (walletId: string): JournalPostingSeed[] =>
    standardPostings({ walletId, kind: 'BET', providerId: PROVIDER, direction: 'DEBIT', amount: '10.00' });

  /** Grava o lançamento numa transação própria: as checagens deferidas rodam no COMMIT. */
  const commitJournal = (transactionId: string, postings: JournalPostingSeed[], currency?: string) =>
    db().transaction((trx) => insertJournal(trx, { transactionId, postings, ...(currency && { currency }) }));

  const journalCount = async (transactionId: string) =>
    Number((await db()('journal_entries').where({ wager_transaction_id: transactionId }).count<{ count: string }[]>('* as count'))[0]!.count);

  describe('lançamentos aceitos', () => {
    it('BET: débito PLAYER, crédito HOUSE do provider', async () => {
      const { walletId, betId } = await walletWithBet();
      await commitJournal(betId, betPostings(walletId));
      expect(await journalCount(betId)).toBe(1);
    });

    it('OPENING: débito FUNDING, crédito PLAYER', async () => {
      const { walletId, openingId } = await seedWallet(orm, '100.00', {}, { journal: false });
      await commitJournal(
        openingId,
        standardPostings({ walletId, kind: 'OPENING', providerId: 'internal', direction: 'CREDIT', amount: '100.00' }),
      );
      expect(await journalCount(openingId)).toBe(1);
    });
  });

  describe('débito = crédito (constraint trigger deferido)', () => {
    it('rejeita no COMMIT lançamento desbalanceado', async () => {
      const { walletId, betId } = await walletWithBet();
      const [player, house] = betPostings(walletId);
      await expectPgError(commitJournal(betId, [player!, { ...house!, amount: '9.99' }]), PG.checkViolation, BALANCED);
      expect(await journalCount(betId)).toBe(0);
    });

    it('rejeita lançamento com uma perna só', async () => {
      const { walletId, betId } = await walletWithBet();
      await expectPgError(commitJournal(betId, betPostings(walletId).slice(0, 1)), PG.checkViolation, BALANCED);
    });

    it('rejeita lançamento sem pernas', async () => {
      const { betId } = await walletWithBet();
      await expectPgError(commitJournal(betId, []), PG.checkViolation, BALANCED);
    });

    it('rejeita perna avulsa acrescentada depois a um lançamento já gravado', async () => {
      const { walletId, betId } = await walletWithBet();
      const journalId = await commitJournal(betId, betPostings(walletId));
      const extra = (direction: 'DEBIT' | 'CREDIT', account: JournalPostingSeed['account']) =>
        accountId(db(), account, 'BRL').then((account_id) => ({
          id: randomUUID(),
          journal_entry_id: journalId,
          account_id,
          direction,
          amount: '1.00',
          currency: 'BRL',
        }));
      const house = { kind: 'PROVIDER_HOUSE', providerId: PROVIDER } as const;
      const player = { kind: 'PLAYER', walletId } as const;
      await expectPgError(
        db().transaction(async (trx) => trx('journal_postings').insert(await extra('DEBIT', player))),
        PG.checkViolation,
        BALANCED,
      );
      // Um par extra que fecha também é recusado: a perna PLAYER deixaria de bater com o ledger.
      await expectPgError(
        db().transaction(async (trx) =>
          trx('journal_postings').insert([await extra('DEBIT', house), await extra('CREDIT', player)]),
        ),
        PG.checkViolation,
        BALANCED,
      );
    });
  });

  describe('coerência com a transação e com o ledger', () => {
    it('rejeita perna PLAYER com direção diferente do lançamento da wallet', async () => {
      const { walletId, betId } = await walletWithBet();
      await expectPgError(
        commitJournal(
          betId,
          standardPostings({ walletId, kind: 'BET', providerId: PROVIDER, direction: 'CREDIT', amount: '10.00' }),
        ),
        PG.checkViolation,
        BALANCED,
      );
    });

    it.each([
      ['FUNDING numa BET', { kind: 'FUNDING' } as const],
      ['HOUSE de outro provider', { kind: 'PROVIDER_HOUSE', providerId: 'provider-b' } as const],
    ])('rejeita contrapartida errada: %s', async (_label, account) => {
      const { walletId, betId } = await walletWithBet();
      const [player, house] = betPostings(walletId);
      await expectPgError(commitJournal(betId, [player!, { ...house!, account }]), PG.checkViolation, BALANCED);
    });

    it('rejeita perna PLAYER de outra wallet', async () => {
      const { betId } = await walletWithBet();
      const other = await seedWallet(orm, '50.00');
      await expectPgError(commitJournal(betId, betPostings(other.walletId)), PG.checkViolation, BALANCED);
    });

    it('rejeita lançamento de transação que não está PROCESSED', async () => {
      const { walletId, playerId } = await walletWithBet();
      const pending = transactionRow({ wallet_id: walletId, player_id: playerId });
      await db()('wager_transactions').insert(pending);
      await expectPgError(commitJournal(pending.id as string, betPostings(walletId)), PG.checkViolation, BALANCED);
    });

    it('rejeita lançamento de LOSS', async () => {
      const { walletId, playerId } = await walletWithBet();
      const loss = processed({ wallet_id: walletId, player_id: playerId, kind: 'LOSS', observed_balance: '90.00' });
      await db()('wager_transactions').insert(loss);
      await expectPgError(commitJournal(loss.id as string, betPostings(walletId)), PG.checkViolation, BALANCED);
    });

    it('rejeita valor diferente do da transação, mesmo balanceado', async () => {
      const { walletId, betId } = await walletWithBet();
      await expectPgError(
        commitJournal(
          betId,
          standardPostings({ walletId, kind: 'BET', providerId: PROVIDER, direction: 'DEBIT', amount: '9.00' }),
        ),
        PG.checkViolation,
        BALANCED,
      );
    });

    it('rejeita segundo lançamento para a mesma transação', async () => {
      const { walletId, betId } = await walletWithBet();
      await commitJournal(betId, betPostings(walletId));
      await expectPgError(commitJournal(betId, betPostings(walletId)), PG.uniqueViolation, 'uq_journal_wager_tx');
    });

    it('rejeita lançamento de transação inexistente', async () => {
      const { walletId } = await walletWithBet();
      await expectPgError(commitJournal(randomUUID(), betPostings(walletId)), PG.foreignKeyViolation, 'fk_journal_wager_tx');
    });
  });

  describe('moeda', () => {
    it('rejeita perna em moeda diferente da do lançamento', async () => {
      const { walletId, betId } = await walletWithBet();
      const insert = db().transaction(async (trx) => {
        // Imediata: senão o balanço (também deferido) pode reprovar antes, pela soma em duas moedas.
        await trx.raw('set constraints fk_postings_entry_currency immediate');
        const journalId = await insertJournal(trx, { transactionId: betId, postings: betPostings(walletId) });
        await trx('journal_postings').insert({
          id: randomUUID(),
          journal_entry_id: journalId,
          account_id: await accountId(trx, { kind: 'FUNDING' }, 'USD'),
          direction: 'CREDIT',
          amount: '1.00',
          currency: 'USD',
        });
      });
      await expectPgError(insert, PG.foreignKeyViolation, 'fk_postings_entry_currency');
    });

    it('rejeita perna em conta de outra moeda', async () => {
      const { walletId, betId } = await walletWithBet();
      const usdHouse = await accountId(db(), { kind: 'PROVIDER_HOUSE', providerId: PROVIDER }, 'USD');
      const insert = db().transaction(async (trx) => {
        const journalId = await insertJournal(trx, { transactionId: betId, postings: betPostings(walletId).slice(0, 1) });
        await trx('journal_postings').insert({
          id: randomUUID(),
          journal_entry_id: journalId,
          account_id: usdHouse,
          direction: 'CREDIT',
          amount: '10.00',
          currency: 'BRL',
        });
      });
      await expectPgError(insert, PG.foreignKeyViolation, 'fk_postings_account_currency');
    });

    it('rejeita conta PLAYER em moeda diferente da wallet', async () => {
      const wallet = walletRow();
      await db()('wallets').insert(wallet);
      const walletId = wallet.id as string;
      await expectPgError(
        db().transaction((trx) => accountId(trx, { kind: 'PLAYER', walletId }, 'USD')),
        PG.foreignKeyViolation,
        'fk_accounts_wallet_currency',
      );
    });
  });

  describe('pernas', () => {
    it.each([
      ['valor zero', { amount: '0.00' }, 'ck_postings_amount_positive'],
      ['valor negativo', { amount: '-1.00' }, 'ck_postings_amount_positive'],
      ['direção inválida', { direction: 'SIDEWAYS' }, 'ck_postings_direction'],
    ])('rejeita %s', async (_label, override, constraint) => {
      const { walletId, betId } = await walletWithBet();
      const insert = db().transaction(async (trx) => {
        const journalId = await insertJournal(trx, { transactionId: betId, postings: betPostings(walletId) });
        await trx('journal_postings').insert({
          id: randomUUID(),
          journal_entry_id: journalId,
          account_id: await accountId(trx, { kind: 'PLAYER', walletId }, 'BRL'),
          direction: 'DEBIT',
          amount: '1.00',
          currency: 'BRL',
          ...override,
        });
      });
      await expectPgError(insert, PG.checkViolation, constraint);
    });
  });

  describe('contas', () => {
    const account = (overrides: Record<string, unknown>) => ({ id: randomUUID(), currency: 'BRL', created_at: T0, ...overrides });

    it.each([
      ['PLAYER sem wallet', { kind: 'PLAYER' }],
      ['PLAYER com provider', { kind: 'PLAYER', wallet_id: randomUUID(), provider_id: PROVIDER }],
      ['HOUSE sem provider', { kind: 'PROVIDER_HOUSE' }],
      ['FUNDING com dono', { kind: 'FUNDING', provider_id: PROVIDER }],
    ])('rejeita %s', async (_label, row) => {
      await expectPgError(db()('accounts').insert(account(row)), PG.checkViolation, 'ck_accounts_owner');
    });

    it('rejeita kind desconhecido', async () => {
      await expectPgError(db()('accounts').insert(account({ kind: 'CASH' })), PG.checkViolation, 'ck_accounts_kind');
    });

    it('rejeita segunda conta PLAYER para a mesma wallet', async () => {
      const wallet = walletRow();
      await db()('wallets').insert(wallet);
      await db()('accounts').insert(account({ kind: 'PLAYER', wallet_id: wallet.id }));
      await expectPgError(
        db()('accounts').insert(account({ kind: 'PLAYER', wallet_id: wallet.id })),
        PG.uniqueViolation,
        'ux_accounts_player',
      );
    });

    it('rejeita segunda HOUSE para o mesmo provider e moeda; outra moeda é permitida', async () => {
      await db()('accounts').insert(account({ kind: 'PROVIDER_HOUSE', provider_id: PROVIDER }));
      await expectPgError(
        db()('accounts').insert(account({ kind: 'PROVIDER_HOUSE', provider_id: PROVIDER })),
        PG.uniqueViolation,
        'ux_accounts_house',
      );
      await db()('accounts').insert(account({ kind: 'PROVIDER_HOUSE', provider_id: PROVIDER, currency: 'USD' }));
    });

    it('rejeita segunda FUNDING na mesma moeda', async () => {
      await db()('accounts').insert(account({ kind: 'FUNDING' }));
      await expectPgError(db()('accounts').insert(account({ kind: 'FUNDING' })), PG.uniqueViolation, 'ux_accounts_funding');
    });
  });

  describe('append-only', () => {
    async function journalRows(): Promise<{ accountId: string; journalId: string; postingId: string }> {
      const { walletId, betId } = await walletWithBet();
      const journalId = await commitJournal(betId, betPostings(walletId));
      const posting = await db()('journal_postings').where({ journal_entry_id: journalId }).first<{ id: string; account_id: string }>();
      return { accountId: posting!.account_id, journalId, postingId: posting!.id };
    }

    const cases: Array<[string, (ids: Awaited<ReturnType<typeof journalRows>>) => Knex.QueryBuilder]> = [
      ['UPDATE em accounts', (ids) => orm.em.getKnex()('accounts').where({ id: ids.accountId }).update({ created_at: new Date() })],
      ['DELETE em accounts', (ids) => orm.em.getKnex()('accounts').where({ id: ids.accountId }).delete()],
      ['UPDATE em journal_entries', (ids) => orm.em.getKnex()('journal_entries').where({ id: ids.journalId }).update({ created_at: new Date() })],
      ['DELETE em journal_entries', (ids) => orm.em.getKnex()('journal_entries').where({ id: ids.journalId }).delete()],
      ['UPDATE em journal_postings', (ids) => orm.em.getKnex()('journal_postings').where({ id: ids.postingId }).update({ amount: '11.00' })],
      ['DELETE em journal_postings', (ids) => orm.em.getKnex()('journal_postings').where({ id: ids.postingId }).delete()],
    ];

    it.each(cases)('rejeita %s', async (_label, action) => {
      const ids = await journalRows();
      await expectPgError(action(ids), PG.restrictViolation);
    });
  });
});
