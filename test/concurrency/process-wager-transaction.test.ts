import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import type { MikroORM } from '@mikro-orm/postgresql';
import { randomUUID } from 'node:crypto';
import type { ProcessWagerTransactionResult } from '../../src/application/wagering/process-wager-transaction';
import { FailureCode } from '../../src/domain/failure-code';
import { buildUseCase, command, countRows, untilSettled, walletBalance } from '../integration/application/harness';
import { expectLedgerConsistent, openOrm, seedWallet, truncateAll } from '../integration/persistence/db';
import { eventually } from '../integration/workers/outbox-harness';

/**
 * Paralelismo real: cada "instância" é um MikroORM próprio (pool e conexões separados),
 * e cada execução abre seu EntityManager (fork) e sua transação. Nada é sequencial.
 */
/** Folga para máquinas lentas: lock_timeout (2s) + espera de pool podem somar mais que os 5s padrão. */
const TIMEOUT_MS = 30_000;

describe('ProcessWagerTransaction — concorrência na mesma wallet', () => {
  const INSTANCES = 3;
  let instances: MikroORM[];
  let useCases: ReturnType<typeof buildUseCase>['useCase'][];
  let orm: MikroORM;

  beforeAll(async () => {
    // A primeira instância migra sozinha; as outras só abrem (sem migrators concorrentes).
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

  const useCaseFor = (i: number) => useCases[i % INSTANCES] as (typeof useCases)[number];
  const debits = (walletId: string) => countRows(orm, 'wallet_ledger_entries', { wallet_id: walletId, direction: 'DEBIT' });

  it('cenário obrigatório: saldo 100.00, duas BETs de 80.00 em paralelo → uma PROCESSED, uma REJECTED, saldo 20.00, um débito', async () => {
    const wallet = await seedWallet(orm, '100.00');
    // Duas apostas distintas; cada uma, se falhar transitoriamente, é reenviada idêntica.
    const bets = [0, 1].map(() => command(wallet, { money: { amount: '80.00', currency: 'BRL' } }));

    const results = await Promise.all(bets.map((bet, i) => untilSettled(() => useCaseFor(i).execute(bet))));

    const processed = results.filter((r) => r.type === 'Processed');
    const rejected = results.filter((r): r is Extract<ProcessWagerTransactionResult, { type: 'Rejected' }> => r.type === 'Rejected');
    expect(processed).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(rejected[0]?.failureCode).toBe(FailureCode.InsufficientBalance);
    expect(await walletBalance(orm, wallet.walletId)).toBe('20.00');
    expect(await debits(wallet.walletId)).toBe(1);
    await expectLedgerConsistent(orm, wallet.walletId);
  });

  it('a mesma BET 50x em paralelo → 1 débito, 1 linha de transação e 49 replays', async () => {
    const wallet = await seedWallet(orm, '100.00');
    const bet = command(wallet, { money: { amount: '30.00', currency: 'BRL' } });

    // TransientFailure (lock_timeout, pool esgotado) é reenviada, como um provedor faria.
    const results = await Promise.all(Array.from({ length: 50 }, (_, i) => untilSettled(() => useCaseFor(i).execute(bet))));

    expect(results.filter((r) => r.type === 'TransientFailure')).toEqual([]);
    const fresh = results.filter((r) => r.type === 'Processed' && !r.idempotentReplay);
    const replays = results.filter((r) => r.type === 'Processed' && r.idempotentReplay);
    expect(fresh).toHaveLength(1);
    expect(replays).toHaveLength(49);
    expect(new Set(results.map((r) => (r as { transactionId: string }).transactionId)).size).toBe(1);
    for (const replay of replays) expect(replay).toEqual({ ...fresh[0]!, idempotentReplay: true } as ProcessWagerTransactionResult);

    expect(await countRows(orm, 'wager_transactions', { idempotency_key: bet.idempotencyKey })).toBe(1);
    expect(await debits(wallet.walletId)).toBe(1);
    expect(await walletBalance(orm, wallet.walletId)).toBe('70.00');
    await expectLedgerConsistent(orm, wallet.walletId);
  }, TIMEOUT_MS);

  it('mesma key com walletIds diferentes em paralelo (locks distintos) → uma processada, a outra conflito (sob lock ou via 23505)', async () => {
    const a = await seedWallet(orm, '100.00');
    const b = await seedWallet(orm, '100.00');
    const external = `ext-${randomUUID()}`;
    const commands = [a, b].map((wallet) => command(wallet, { externalTransactionId: external }));

    const results = await Promise.all(commands.map((cmd, i) => untilSettled(() => useCaseFor(i).execute(cmd))));

    expect(results.map((r) => r.type).sort()).toEqual(['IdempotencyConflict', 'Processed']);
    expect(await countRows(orm, 'wager_transactions', { external_transaction_id: external })).toBe(1);
    await expectLedgerConsistent(orm, a.walletId);
    await expectLedgerConsistent(orm, b.walletId);
  });

  it('BETs concorrentes até esgotar o saldo: nunca negativo, um débito por aceite', async () => {
    const wallet = await seedWallet(orm, '100.00');
    const bets = Array.from({ length: 30 }, () => command(wallet, { money: { amount: '7.00', currency: 'BRL' } }));
    const results = await Promise.all(bets.map((bet, i) => untilSettled(() => useCaseFor(i).execute(bet))));

    const accepted = results.filter((r) => r.type === 'Processed').length;
    expect(accepted).toBe(14); // 14 × 7.00 = 98.00
    expect(results.filter((r) => r.type === 'Rejected')).toHaveLength(16);
    expect(await walletBalance(orm, wallet.walletId)).toBe('2.00');
    expect(await debits(wallet.walletId)).toBe(14);
    await expectLedgerConsistent(orm, wallet.walletId);
  }, TIMEOUT_MS);

  // CHALLENGE §5.6 / §8 / §13 (concorrência, item 3): a unidade de concorrência é a wallet, não há
  // lock global. Com uma transação do use case parada no lock da wallet A, 12 outras wallets são
  // processadas em paralelo nas 3 instâncias sem esperar por ela. Com um lock global, elas ficariam
  // atrás da transação de A e voltariam como TransientFailure (lock_timeout).
  it('wallet travada não bloqueia as outras: 12 wallets em paralelo processam enquanto A espera o lock', async () => {
    const hot = await seedWallet(orm, '100.00');
    const others = await Promise.all(Array.from({ length: 12 }, () => seedWallet(orm, '50.00')));
    const release = Promise.withResolvers<void>();
    const locked = Promise.withResolvers<void>();
    const holder = orm.em.getKnex().transaction(async (trx) => {
      await trx.raw('select id from wallets where id = ? for update', [hot.walletId]);
      locked.resolve();
      await release.promise;
    });
    await locked.promise;
    try {
      const blocked = useCaseFor(0).execute(command(hot)).then((r) => r, (e: unknown) => e);
      // A transação do use case de A está aberta e parada no lock da linha da wallet A.
      await eventually(async () => {
        const { rows } = await orm.em.getKnex().raw(`select 1 from pg_stat_activity where wait_event_type = 'Lock' and query ilike '%wallets%'`);
        expect(rows.length, 'o use case de A espera o lock da wallet').toBe(1);
      }, 1_500);

      const results = await Promise.all(
        others.flatMap((wallet, i) => [0, 1].map((n) => useCaseFor(i + n + 1).execute(command(wallet, { money: { amount: '20.00', currency: 'BRL' } })))),
      );
      expect(results.map((r) => r.type)).toEqual(Array(24).fill('Processed'));
      for (const wallet of others) {
        expect(await walletBalance(orm, wallet.walletId)).toBe('10.00');
        await expectLedgerConsistent(orm, wallet.walletId);
      }
      release.resolve();
      await holder;
      // A: aplicada depois da liberação ou devolvida como transitória pelo lock_timeout; nunca duplicada.
      expect(['Processed', 'TransientFailure']).toContain((await blocked as ProcessWagerTransactionResult).type);
      expect(await debits(hot.walletId)).toBeLessThanOrEqual(1);
      await expectLedgerConsistent(orm, hot.walletId);
    } finally {
      release.resolve();
      await holder.catch(() => undefined);
    }
  }, TIMEOUT_MS);
});
