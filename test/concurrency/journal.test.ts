import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import type { MikroORM } from '@mikro-orm/postgresql';
import { randomUUID } from 'node:crypto';
import { ReconcileWallet } from '../../src/application/wallets/reconcile-wallet';
import { PostgresWalletReconciliationReader } from '../../src/infrastructure/persistence/postgres-wallet-reconciliation.reader';
import { buildUseCase, command, untilSettled, type WalletRef } from '../integration/application/harness';
import { expectJournalConsistent, expectLedgerConsistent, openOrm, seedWallet, truncateAll } from '../integration/persistence/db';

const TIMEOUT_MS = 60_000;

/**
 * Invariante dos três saldos sob concorrência real: 3 "instâncias" (MikroORM e pool próprios),
 * várias wallets e providers, BET/WIN/REFUND/ROLLBACK em paralelo, e o primeiro uso de uma conta
 * HOUSE disputado por todas as wallets ao mesmo tempo. Postgres real.
 */
describe('diário de partidas dobradas — concorrência', () => {
  const INSTANCES = 3;
  const WALLETS = 6;
  let instances: MikroORM[];
  let useCases: ReturnType<typeof buildUseCase>['useCase'][];
  let orm: MikroORM;

  beforeAll(async () => {
    const first = await openOrm();
    instances = [first, ...(await Promise.all(Array.from({ length: INSTANCES - 1 }, () => openOrm())))];
    [orm] = instances as [MikroORM];
    useCases = instances.map((instance) => buildUseCase(instance).useCase);
  });

  beforeEach(async () => {
    await truncateAll(orm);
  });

  afterAll(async () => {
    await Promise.all(instances.map((instance) => instance.close(true)));
  });

  const rows = async <T>(sql: string, bindings: unknown[] = []) =>
    (await orm.em.getKnex().raw<{ rows: T[] }>(sql, bindings as never)).rows;

  it(
    'saldo PLAYER no diário == wallet.balance == ledger em todas as wallets; contas únicas; débito = crédito; HOUSE fecha com os jogadores',
    async () => {
      const wallets: WalletRef[] = await Promise.all(Array.from({ length: WALLETS }, () => seedWallet(orm, '100.00')));
      // Provider novo a cada execução: a conta HOUSE dele nasce disputada por todas as wallets.
      const providers = [`provider-${randomUUID()}`, 'provider-a'];
      let n = 0;
      const run = (wallet: WalletRef, payload: Record<string, unknown>) =>
        untilSettled(() => useCases[n++ % INSTANCES]!.execute(command(wallet, payload)));

      // Etapa 1: 8 BETs de 15 por wallet (só 6 cabem em 100), alternando providers, tudo em paralelo.
      const bets = wallets.flatMap((wallet, w) =>
        Array.from({ length: 8 }, (_, i) => {
          const providerId = providers[i % 2]!;
          const externalTransactionId = `bet-${w}-${i}`;
          return { wallet, providerId, externalTransactionId, roundId: `round-${i}` };
        }),
      );
      const betResults = await Promise.all(
        bets.map((bet) =>
          run(bet.wallet, {
            providerId: bet.providerId,
            externalTransactionId: bet.externalTransactionId,
            roundId: bet.roundId,
            money: { amount: '15.00', currency: 'BRL' },
          }),
        ),
      );
      expect(betResults.every((r) => r.type === 'Processed' || r.type === 'Rejected')).toBe(true);
      const processedBets = bets.filter((_, i) => betResults[i]!.type === 'Processed');
      expect(processedBets).toHaveLength(WALLETS * 6);

      // Etapa 2, em paralelo: por BET processada, WIN (i%3=0), REFUND (i%3=1) ou ROLLBACK (i%3=2).
      // Depois, em paralelo também, ROLLBACK de cada WIN (reverte um crédito: pode faltar saldo).
      const follow = (kind: string, bet: (typeof bets)[number], amount: string, reference: string, external: string) =>
        run(bet.wallet, {
          providerId: bet.providerId,
          externalTransactionId: external,
          roundId: bet.roundId,
          kind,
          referenceExternalTransactionId: reference,
          money: { amount, currency: 'BRL' },
        });
      const kinds = ['WIN', 'REFUND', 'ROLLBACK'] as const;
      const second = await Promise.all(
        processedBets.map((bet, i) => {
          const kind = kinds[i % 3]!;
          return follow(kind, bet, kind === 'WIN' ? '40.00' : '15.00', bet.externalTransactionId, `${kind.toLowerCase()}-${bet.externalTransactionId}`);
        }),
      );
      expect(second.every((r) => r.type === 'Processed')).toBe(true);
      const wins = processedBets.filter((_, i) => i % 3 === 0);
      const third = await Promise.all(
        wins.map((bet) => follow('ROLLBACK', bet, '40.00', `win-${bet.externalTransactionId}`, `rb-win-${bet.externalTransactionId}`)),
      );
      expect(third.every((r) => r.type === 'Processed' || r.type === 'Rejected')).toBe(true);

      // Invariante dos três saldos, wallet a wallet, também pela reconciliação.
      const reconcile = new ReconcileWallet(new PostgresWalletReconciliationReader(orm.em));
      for (const wallet of wallets) {
        await expectLedgerConsistent(orm, wallet.walletId);
        await expectJournalConsistent(orm, wallet.walletId);
        const result = await reconcile.execute(wallet.walletId);
        expect(result).toMatchObject({ type: 'Reconciled', consistent: true, divergences: [] });
      }

      // Uma conta por dono: PLAYER por wallet, HOUSE por provider, FUNDING por moeda.
      expect(
        await rows(`select kind, wallet_id, provider_id, currency from accounts
                     group by kind, wallet_id, provider_id, currency having count(*) > 1`),
      ).toEqual([]);
      const houses = await rows<{ provider_id: string }>(`select provider_id from accounts where kind = 'PROVIDER_HOUSE' order by 1`);
      expect(houses.map((h) => h.provider_id).sort()).toEqual([...providers].sort());

      // Débito = crédito em cada lançamento e no total.
      expect(
        await rows(`select journal_entry_id from journal_postings group by 1
                     having sum(case direction when 'DEBIT' then amount else 0 end) <> sum(case direction when 'CREDIT' then amount else 0 end)`),
      ).toEqual([]);
      const [totals] = await rows<{ debits: string; credits: string }>(
        `select sum(amount) filter (where direction = 'DEBIT')::text as debits, sum(amount) filter (where direction = 'CREDIT')::text as credits from journal_postings`,
      );
      expect(totals!.debits).toBe(totals!.credits);

      // HOUSE de cada provider = − Σ movimentos dos jogadores naquele provider (pelo ledger).
      const mismatched = await rows(
        `select h.provider_id, h.house, coalesce(m.players, 0) as players
           from (select a.provider_id, sum(case p.direction when 'CREDIT' then p.amount else -p.amount end) as house
                   from accounts a join journal_postings p on p.account_id = a.id
                  where a.kind = 'PROVIDER_HOUSE' group by a.provider_id) h
           left join (select t.provider_id, sum(case l.direction when 'CREDIT' then l.amount else -l.amount end) as players
                        from wallet_ledger_entries l join wager_transactions t on t.id = l.transaction_id
                       where t.kind <> 'OPENING' group by t.provider_id) m on m.provider_id = h.provider_id
          where h.house <> -coalesce(m.players, 0)`,
      );
      expect(mismatched).toEqual([]);
    },
    TIMEOUT_MS,
  );
});
