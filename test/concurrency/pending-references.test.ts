import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import type { MikroORM } from '@mikro-orm/postgresql';
import { command, untilSettled, walletBalance } from '../integration/application/harness';
import { T0, expectLedgerConsistent, openOrm, seedWallet, truncateAll } from '../integration/persistence/db';
import { ManualClock } from '../integration/workers/outbox-harness';
import { buildPendingFixture, counterTotal, entriesOf, eventsOf, pendingCount, txByExternal } from '../integration/workers/pending-harness';

/** Folga para máquinas lentas (lock_timeout 2s + pool). */
const TIMEOUT_MS = 30_000;
const brl = (amount: string) => ({ amount, currency: 'BRL' });

/**
 * Paralelismo real: cada instância é um MikroORM próprio (pool separado). O relógio é manual e
 * compartilhado; só o caminho rápido torna as pendentes vencidas.
 */
describe('worker de referências pendentes — concorrência', () => {
  let instances: MikroORM[];
  let orm: MikroORM;
  let clock: ManualClock;

  beforeAll(async () => {
    const first = await openOrm();
    instances = [first, await openOrm(), await openOrm()];
    orm = first;
  });

  beforeEach(async () => {
    await truncateAll(orm);
    clock = new ManualClock(T0);
  });

  afterAll(async () => {
    await Promise.all(instances.map((instance) => instance.close(true)));
  });

  /** Roda `runOnce` até não haver mais pendentes (com prazo). */
  async function drainWith(worker: ReturnType<typeof buildPendingFixture>['worker'], deadline: number): Promise<void> {
    while ((await pendingCount(orm)) > 0) {
      if (Date.now() > deadline) throw new Error('pendentes não resolvidas no prazo');
      const { progressed } = await worker.runOnce();
      if (progressed === 0) await Bun.sleep(5);
    }
  }

  it(
    'dois workers sobre as mesmas pendentes (várias wallets, várias por wallet) → um único efeito por transação',
    async () => {
      const [a, b] = instances.slice(0, 2).map((instance) => buildPendingFixture(instance, clock)) as [
        ReturnType<typeof buildPendingFixture>,
        ReturnType<typeof buildPendingFixture>,
      ];
      const wallets = await Promise.all([0, 1, 2, 3].map(() => seedWallet(orm, '100.00')));
      const rollbacks: string[] = [];
      for (const [w, wallet] of wallets.entries()) {
        for (let n = 0; n < 5; n++) {
          const ext = `w${w}-${n}`;
          await a.useCase.execute(command(wallet, { externalTransactionId: `rb-${ext}`, kind: 'ROLLBACK', referenceExternalTransactionId: `bet-${ext}`, money: brl('10.00') }));
          await a.useCase.execute(command(wallet, { externalTransactionId: `bet-${ext}`, money: brl('10.00') }));
          rollbacks.push(`rb-${ext}`);
        }
      }

      const deadline = Date.now() + TIMEOUT_MS - 5_000;
      await Promise.all([drainWith(a.worker, deadline), drainWith(b.worker, deadline)]);

      for (const ext of rollbacks) {
        const rb = await txByExternal(orm, ext);
        expect(rb.status).toBe('PROCESSED');
        expect(await entriesOf(orm, rb.id)).toBe(1);
        expect((await eventsOf(orm, rb.id)).filter((e) => e.event_type === 'WagerTransactionProcessed')).toHaveLength(1);
      }
      const resolved =
        (await counterTotal(a.metrics.pendingReferenceResolved)) + (await counterTotal(b.metrics.pendingReferenceResolved));
      expect(resolved).toBe(rollbacks.length);
      const skipped = async (reason: string) =>
        (await counterTotal(a.metrics.pendingReferenceSkipped, { reason })) +
        (await counterTotal(b.metrics.pendingReferenceSkipped, { reason }));
      // Nenhum erro inesperado escondido pela corrida, e houve disputa de fato entre as instâncias.
      expect(await skipped('error')).toBe(0);
      expect((await skipped('wallet_busy')) + (await skipped('not_due'))).toBeGreaterThan(0);
      for (const wallet of wallets) {
        expect(await walletBalance(orm, wallet.walletId)).toBe('100.00');
        await expectLedgerConsistent(orm, wallet.walletId);
      }
    },
    TIMEOUT_MS,
  );

  it(
    'worker e use case ao mesmo tempo na mesma wallet → sem deadlock e sem efeito duplicado',
    async () => {
      const [entry, other, workerInstance] = instances.map((instance) => buildPendingFixture(instance, clock)) as [
        ReturnType<typeof buildPendingFixture>,
        ReturnType<typeof buildPendingFixture>,
        ReturnType<typeof buildPendingFixture>,
      ];
      const wallet = await seedWallet(orm, '1000.00');
      const N = 15;
      for (let n = 0; n < N; n++) {
        await entry.useCase.execute(command(wallet, { externalTransactionId: `rb-${n}`, kind: 'ROLLBACK', referenceExternalTransactionId: `bet-${n}`, money: brl('10.00') }));
      }

      // BETs chegando por duas instâncias enquanto o worker (terceira) resolve as antecipadas.
      const deadline = Date.now() + TIMEOUT_MS - 5_000;
      let betsDone = false;
      const bets = Promise.all(
        Array.from({ length: N }, (_, n) =>
          untilSettled(() => (n % 2 === 0 ? entry : other).useCase.execute(command(wallet, { externalTransactionId: `bet-${n}`, money: brl('10.00') }))),
        ),
      ).finally(() => (betsDone = true));
      const worker = (async () => {
        while (!betsDone || (await pendingCount(orm)) > 0) {
          if (Date.now() > deadline) throw new Error('pendentes não resolvidas no prazo');
          const { progressed } = await workerInstance.worker.runOnce();
          if (progressed === 0) await Bun.sleep(2);
        }
      })();
      const [results] = await Promise.all([bets, worker]);

      expect(results.every((r) => r.type === 'Processed')).toBe(true);
      for (let n = 0; n < N; n++) {
        const rb = await txByExternal(orm, `rb-${n}`);
        expect(rb.status).toBe('PROCESSED');
        expect(await entriesOf(orm, rb.id)).toBe(1);
        expect(await entriesOf(orm, (await txByExternal(orm, `bet-${n}`)).id)).toBe(1);
      }
      // Deadlock apareceria como TransientFailure no use case (telemetria) ou transient no worker.
      expect(
        (await counterTotal(entry.metrics.lockConflicts, { reason: 'deadlock' })) +
          (await counterTotal(other.metrics.lockConflicts, { reason: 'deadlock' })),
      ).toBe(0);
      expect(await counterTotal(workerInstance.metrics.pendingReferenceSkipped, { reason: 'transient' })).toBe(0);
      expect(await counterTotal(workerInstance.metrics.pendingReferenceSkipped, { reason: 'error' })).toBe(0);
      expect(await walletBalance(orm, wallet.walletId)).toBe('1000.00');
      await expectLedgerConsistent(orm, wallet.walletId);
    },
    TIMEOUT_MS,
  );
});
