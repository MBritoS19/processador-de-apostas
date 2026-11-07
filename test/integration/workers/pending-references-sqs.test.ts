import 'reflect-metadata';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import type { INestApplication } from '@nestjs/common';
import type { MikroORM } from '@mikro-orm/postgresql';
import { loadConfig } from '../../../src/infrastructure/config/app-config';
import { createSqsClient } from '../../../src/infrastructure/messaging/sqs.client';
import { PendingReferenceWorker } from '../../../src/interfaces/workers/pending-reference-worker';
import { walletBalance } from '../application/harness';
import { expectLedgerConsistent, openOrm, seedWallet, truncateAll } from '../persistence/db';
import { createQueues, deleteQueues, envelope, eventually, send, startConsumerApp, type TestQueues } from '../interfaces/sqs-harness';
import { entriesOf, txByExternal } from './pending-harness';

const isRunning = (worker: PendingReferenceWorker) => (worker as unknown as { loop?: Promise<void> }).loop !== undefined;

/** Ponta a ponta pela fila: aplicação Nest inteira, consumidor e worker ligados, LocalStack e Postgres reais. */
describe('referências pendentes pela fila SQS', () => {
  const sqs = createSqsClient(loadConfig());
  let orm: MikroORM;
  let queues: TestQueues;
  let app: INestApplication | undefined;

  beforeAll(async () => {
    orm = await openOrm();
  });

  beforeEach(async () => {
    await truncateAll(orm);
    queues = await createQueues(sqs);
  });

  afterEach(async () => {
    await app?.close();
    app = undefined;
    await deleteQueues(sqs, queues);
  });

  afterAll(async () => {
    await orm.close();
    sqs.destroy();
  });

  it('ROLLBACK antes da BET, ambos pela fila → o worker do app resolve; app.close() para o worker', async () => {
    app = await startConsumerApp({ queues, pendingReferences: { workerEnabled: true, pollIntervalMs: 50 } });
    const worker = app.get(PendingReferenceWorker);
    expect(isRunning(worker)).toBe(true);
    const wallet = await seedWallet(orm, '100.00');
    const money = { amount: '25.00', currency: 'BRL' };

    await send(sqs, queues.queueUrl, envelope(wallet, { data: { externalTransactionId: 'rb-1', idempotencyKey: 'provider-a:rb-1', kind: 'ROLLBACK', referenceExternalTransactionId: 'bet-1', money } }));
    await eventually(async () => expect((await txByExternal(orm, 'rb-1')).status).toBe('PENDING_REFERENCE'));
    await send(sqs, queues.queueUrl, envelope(wallet, { data: { externalTransactionId: 'bet-1', idempotencyKey: 'provider-a:bet-1', money } }));

    // Caminho rápido + worker: resolve bem antes do primeiro reagendamento (5s).
    await eventually(async () => expect((await txByExternal(orm, 'rb-1')).status).toBe('PROCESSED'), 4_000);
    const rb = await txByExternal(orm, 'rb-1');
    expect(rb.observed_balance).toBe('100.00');
    expect(await entriesOf(orm, rb.id)).toBe(1);
    expect(await entriesOf(orm, (await txByExternal(orm, 'bet-1')).id)).toBe(1);
    expect(await walletBalance(orm, wallet.walletId)).toBe('100.00');
    await expectLedgerConsistent(orm, wallet.walletId);

    await app.close();
    app = undefined;
    expect(isRunning(worker)).toBe(false);
  });

  it('PENDING_REFERENCE_WORKER_ENABLED=false → o worker não inicia', async () => {
    app = await startConsumerApp({ queues, pendingReferences: { workerEnabled: false } });
    expect(isRunning(app.get(PendingReferenceWorker))).toBe(false);
  });
});
