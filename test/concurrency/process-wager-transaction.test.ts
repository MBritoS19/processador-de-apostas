import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import type { MikroORM } from '@mikro-orm/postgresql';
import { randomUUID } from 'node:crypto';
import type { ProcessWagerTransactionResult } from '../../src/application/wagering/process-wager-transaction';
import { FailureCode } from '../../src/domain/failure-code';
import { buildUseCase, command, countRows, untilSettled, walletBalance } from '../integration/application/harness';
import { expectLedgerConsistent, openOrm, seedWallet, truncateAll } from '../integration/persistence/db';

/**
 * Paralelismo real: cada "instância" é um MikroORM próprio (pool e conexões separados),
 * e cada execução abre seu EntityManager (fork) e sua transação. Nada é sequencial.
 */
describe('ProcessWagerTransaction — concorrência na mesma wallet', () => {
  const INSTANCES = 3;
  let instances: MikroORM[];
  let useCases: ReturnType<typeof buildUseCase>['useCase'][];
  let orm: MikroORM;

  beforeAll(async () => {
    instances = await Promise.all(Array.from({ length: INSTANCES }, () => openOrm()));
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
    const bet = () => command(wallet, { money: { amount: '80.00', currency: 'BRL' } });

    const results = await Promise.all([0, 1].map((i) => untilSettled(() => useCaseFor(i).execute(bet()))));

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
  });

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
    const results = await Promise.all(
      Array.from({ length: 30 }, (_, i) =>
        untilSettled(() => useCaseFor(i).execute(command(wallet, { money: { amount: '7.00', currency: 'BRL' } }))),
      ),
    );

    const accepted = results.filter((r) => r.type === 'Processed').length;
    expect(accepted).toBe(14); // 14 × 7.00 = 98.00
    expect(results.filter((r) => r.type === 'Rejected')).toHaveLength(16);
    expect(await walletBalance(orm, wallet.walletId)).toBe('2.00');
    expect(await debits(wallet.walletId)).toBe(14);
    await expectLedgerConsistent(orm, wallet.walletId);
  });
});
