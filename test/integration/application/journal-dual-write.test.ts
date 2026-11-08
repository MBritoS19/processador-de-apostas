import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import type { MikroORM } from '@mikro-orm/postgresql';
import { OpenWallet } from '../../../src/application/wallets/open-wallet';
import { MikroOrmWagerUnitOfWork } from '../../../src/infrastructure/persistence/mikro-orm-wager-unit-of-work';
import { randomIdGenerator } from '../../../src/infrastructure/system-adapters';
import { T0, expectJournalConsistent, expectLedgerConsistent, openOrm, truncateAll } from '../persistence/db';
import { ManualClock } from '../workers/outbox-harness';
import { buildPendingFixture, txByExternal } from '../workers/pending-harness';
import { command, countRows, type WalletRef } from './harness';

/**
 * Gravação dupla: todo lançamento do ledger ganha, na mesma transação SQL, o lançamento de diário
 * correspondente (OpenWallet, use case e worker de pendentes). Postgres real.
 */
describe('diário de partidas dobradas — gravação dupla', () => {
  let orm: MikroORM;
  let fixture: ReturnType<typeof buildPendingFixture>;
  let openWallet: OpenWallet;

  beforeAll(async () => {
    orm = await openOrm();
  });

  beforeEach(async () => {
    await truncateAll(orm);
    const clock = new ManualClock(T0);
    fixture = buildPendingFixture(orm, clock);
    openWallet = new OpenWallet(new MikroOrmWagerUnitOfWork(orm.em), clock, randomIdGenerator);
  });

  afterAll(async () => {
    await orm.close(true);
  });

  async function open(amount: string): Promise<WalletRef> {
    const playerId = `player-${crypto.randomUUID()}`;
    const result = await openWallet.execute({ playerId, initialBalance: { amount, currency: 'BRL' }, correlationId: 'corr-1' });
    if (result.type !== 'Opened') throw new Error(`abertura falhou: ${result.type}`);
    return { walletId: result.wallet.id, playerId };
  }

  const submit = (wallet: WalletRef, externalTransactionId: string, payload: Record<string, unknown> = {}) =>
    fixture.useCase.execute(command(wallet, { externalTransactionId, ...payload }));

  /** Pernas do lançamento de diário da transação: [conta, direção, valor], débito primeiro. */
  async function legsOf(externalTransactionId: string, providerId = 'provider-a') {
    const { id } = await txByExternal(orm, externalTransactionId, providerId);
    const rows = await orm.em.getKnex().raw<{ rows: Array<{ kind: string; owner: string | null; direction: string; amount: string }> }>(
      `select a.kind, coalesce(a.provider_id, a.wallet_id::text, a.currency) as owner, p.direction, p.amount::text as amount
         from journal_entries j join journal_postings p on p.journal_entry_id = j.id join accounts a on a.id = p.account_id
        where j.wager_transaction_id = ? order by p.direction desc`,
      [id],
    );
    return rows.rows.map((row) => [row.kind, row.owner, row.direction, row.amount]);
  }

  /** Saldo (crédito − débito) de cada conta de contrapartida. */
  async function counterpartBalances() {
    const rows = await orm.em.getKnex().raw<{ rows: Array<{ kind: string; owner: string | null; balance: string }> }>(
      `select a.kind, coalesce(a.provider_id, a.currency) as owner,
              sum(case p.direction when 'CREDIT' then p.amount else -p.amount end)::text as balance
         from accounts a join journal_postings p on p.account_id = a.id
        where a.kind <> 'PLAYER' group by a.kind, a.provider_id, a.currency order by 1, 2`,
    );
    return rows.rows;
  }

  it('OpenWallet: OPENING com saldo debita FUNDING e credita PLAYER; saldo zero não lança nem cria conta', async () => {
    const funded = await open('100.00');
    const { id: openingId } = await txByExternal(orm, `opening:${funded.walletId}`, 'internal');
    const legs = await orm.em.getKnex()('journal_entries').where({ wager_transaction_id: openingId }).count({ n: '*' });
    expect(Number(legs[0]!.n)).toBe(1);
    expect(await legsOf(`opening:${funded.walletId}`, 'internal')).toEqual([
      ['FUNDING', 'BRL', 'DEBIT', '100.00'],
      ['PLAYER', funded.walletId, 'CREDIT', '100.00'],
    ]);

    const empty = await open('0.00');
    expect(await countRows(orm, 'accounts', { wallet_id: empty.walletId })).toBe(0);
    await expectJournalConsistent(orm, funded.walletId);
    await expectJournalConsistent(orm, empty.walletId);
  });

  it('cada kind que move saldo lança com a contrapartida certa; LOSS e REJECTED não lançam', async () => {
    const wallet = await open('100.00');
    const processed = async (external: string, payload: Record<string, unknown> = {}) =>
      expect((await submit(wallet, external, payload)).type).toBe('Processed');

    await processed('bet-1', { money: { amount: '30.00', currency: 'BRL' } });
    await processed('win-1', { kind: 'WIN', money: { amount: '45.00', currency: 'BRL' }, referenceExternalTransactionId: 'bet-1' });
    await processed('bet-2', { roundId: 'round-2', money: { amount: '20.00', currency: 'BRL' } });
    await processed('loss-2', { kind: 'LOSS', roundId: 'round-2', money: { amount: '0.00', currency: 'BRL' }, referenceExternalTransactionId: 'bet-2' });
    await processed('bet-3', { roundId: 'round-3', money: { amount: '5.00', currency: 'BRL' } });
    await processed('refund-3', { kind: 'REFUND', roundId: 'round-3', money: { amount: '5.00', currency: 'BRL' }, referenceExternalTransactionId: 'bet-3' });
    await processed('rb-win-1', { kind: 'ROLLBACK', money: { amount: '45.00', currency: 'BRL' }, referenceExternalTransactionId: 'win-1' });
    await processed('bet-b', { providerId: 'provider-b', roundId: 'round-b', money: { amount: '7.50', currency: 'BRL' } });
    const rejected = await submit(wallet, 'bet-too-much', { money: { amount: '1000.00', currency: 'BRL' } });
    expect(rejected.type).toBe('Rejected');

    const w = wallet.walletId;
    expect(await legsOf('bet-1')).toEqual([['PLAYER', w, 'DEBIT', '30.00'], ['PROVIDER_HOUSE', 'provider-a', 'CREDIT', '30.00']]);
    expect(await legsOf('win-1')).toEqual([['PROVIDER_HOUSE', 'provider-a', 'DEBIT', '45.00'], ['PLAYER', w, 'CREDIT', '45.00']]);
    expect(await legsOf('refund-3')).toEqual([['PROVIDER_HOUSE', 'provider-a', 'DEBIT', '5.00'], ['PLAYER', w, 'CREDIT', '5.00']]);
    expect(await legsOf('rb-win-1')).toEqual([['PLAYER', w, 'DEBIT', '45.00'], ['PROVIDER_HOUSE', 'provider-a', 'CREDIT', '45.00']]);
    expect(await legsOf('bet-b', 'provider-b')).toEqual([['PLAYER', w, 'DEBIT', '7.50'], ['PROVIDER_HOUSE', 'provider-b', 'CREDIT', '7.50']]);
    expect(await legsOf('loss-2')).toEqual([]);
    expect(await legsOf('bet-too-much')).toEqual([]);

    // 100 − 30 + 45 − 20 − 5 + 5 − 45 − 7,50 = 42,50
    await expectLedgerConsistent(orm, w);
    await expectJournalConsistent(orm, w);
    expect(await counterpartBalances()).toEqual([
      { kind: 'FUNDING', owner: 'BRL', balance: '-100.00' },
      { kind: 'PROVIDER_HOUSE', owner: 'provider-a', balance: '50.00' },
      { kind: 'PROVIDER_HOUSE', owner: 'provider-b', balance: '7.50' },
    ]);
  });

  it('worker de pendentes: ROLLBACK resolvido depois da BET lança no diário na mesma transação', async () => {
    const wallet = await open('100.00');
    const early = await submit(wallet, 'rb-1', { kind: 'ROLLBACK', referenceExternalTransactionId: 'bet-1' });
    expect(early.type).toBe('PendingReference');
    expect(await legsOf('rb-1')).toEqual([]);
    expect((await submit(wallet, 'bet-1')).type).toBe('Processed');

    const due = await fixture.resolver.findDue(10);
    expect(due).toHaveLength(1);
    await fixture.resolver.resolve(due[0]!);

    expect((await txByExternal(orm, 'rb-1')).status).toBe('PROCESSED');
    expect(await legsOf('rb-1')).toEqual([
      ['PROVIDER_HOUSE', 'provider-a', 'DEBIT', '10.00'],
      ['PLAYER', wallet.walletId, 'CREDIT', '10.00'],
    ]);
    await expectLedgerConsistent(orm, wallet.walletId);
    await expectJournalConsistent(orm, wallet.walletId);
  });
});
