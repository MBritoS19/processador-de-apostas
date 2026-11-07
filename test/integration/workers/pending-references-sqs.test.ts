import 'reflect-metadata';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import type { INestApplication } from '@nestjs/common';
import type { MikroORM } from '@mikro-orm/postgresql';
import { loadConfig } from '../../../src/infrastructure/config/app-config';
import { createSqsClient } from '../../../src/infrastructure/messaging/sqs.client';
import { PendingReferenceWorker } from '../../../src/interfaces/workers/pending-reference-worker';
import { countRows, walletBalance } from '../application/harness';
import { expectLedgerConsistent, openOrm, seedWallet, truncateAll } from '../persistence/db';
import { createQueues, deleteQueues, envelope, eventually, send, startConsumerApp, type TestQueues } from '../interfaces/sqs-harness';
import { entriesOf, eventsOf, txByExternal } from './pending-harness';

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

    const rollback = { externalTransactionId: 'rb-1', idempotencyKey: 'provider-a:rb-1', kind: 'ROLLBACK', referenceExternalTransactionId: 'bet-1', money };
    const first = envelope(wallet, { data: rollback });
    await send(sqs, queues.queueUrl, first);
    await eventually(async () => expect((await txByExternal(orm, 'rb-1')).status).toBe('PENDING_REFERENCE'));
    await send(sqs, queues.queueUrl, envelope(wallet, { data: { externalTransactionId: 'bet-1', idempotencyKey: 'provider-a:bet-1', money } }));

    // Relógio real: o caminho rápido é provado no teste de integração com relógio manual.
    await eventually(async () => expect((await txByExternal(orm, 'rb-1')).status).toBe('PROCESSED'), 15_000);
    const rb = await txByExternal(orm, 'rb-1');
    const [pendingEvent, processedEvent] = await eventsOf(orm, rb.id);
    expect(pendingEvent?.payload.causationId).toBe(first.messageId as string);
    expect(processedEvent?.payload).toMatchObject({ causationId: pendingEvent?.id });
    expect(rb.observed_balance).toBe('100.00');
    expect(await entriesOf(orm, rb.id)).toBe(1);
    expect(await entriesOf(orm, (await txByExternal(orm, 'bet-1')).id)).toBe(1);
    expect(await walletBalance(orm, wallet.walletId)).toBe('100.00');
    await expectLedgerConsistent(orm, wallet.walletId);

    // Replay pela fila (outra mensagem, mesma key e payload): sem novo efeito, inbox gravada.
    const replay = envelope(wallet, { data: rollback });
    await send(sqs, queues.queueUrl, replay);
    await eventually(async () => expect(await countRows(orm, 'inbox_messages', { message_id: replay.messageId })).toBe(1));
    expect(await entriesOf(orm, rb.id)).toBe(1);
    expect(await walletBalance(orm, wallet.walletId)).toBe('100.00');
    expect((await eventsOf(orm, rb.id)).map((e) => e.event_type)).toEqual(['WagerTransactionPendingReference', 'WagerTransactionProcessed']);

    await app.close();
    app = undefined;
    expect(isRunning(worker)).toBe(false);
  });

  it('PENDING_REFERENCE_TTL_MS chega ao use case (agendamento limitado ao prazo) e ao worker (expira)', async () => {
    app = await startConsumerApp({ queues, pendingReferences: { workerEnabled: true, pollIntervalMs: 50, ttlMs: 3_000 } });
    const wallet = await seedWallet(orm, '100.00');
    await send(sqs, queues.queueUrl, envelope(wallet, { data: { externalTransactionId: 'rb-1', idempotencyKey: 'provider-a:rb-1', kind: 'ROLLBACK', referenceExternalTransactionId: 'nunca', money: { amount: '1.00', currency: 'BRL' } } }));

    // Pendente por ~3s (o prazo): janela folgada para ler o agendamento.
    await eventually(async () => expect((await txByExternal(orm, 'rb-1')).status).toBe('PENDING_REFERENCE'));
    const [row] = await orm.em.fork().getKnex()('wager_transactions').where({ external_transaction_id: 'rb-1' }).select('created_at');
    const createdAt = new Date(row.created_at as string).getTime();
    const pending = await txByExternal(orm, 'rb-1');
    // Use case: min(5s de backoff, createdAt + 3s) — só com o TTL da config.
    expect(pending.next_reference_check_at?.getTime()).toBe(createdAt + 3_000);
    await eventually(async () => expect((await txByExternal(orm, 'rb-1')).failure_code).toBe('REFERENCE_NOT_FOUND'), 10_000);
    await expectLedgerConsistent(orm, wallet.walletId);
  });

  it('PENDING_REFERENCE_WORKER_ENABLED=false → o worker não inicia', async () => {
    app = await startConsumerApp({ queues, pendingReferences: { workerEnabled: false } });
    expect(isRunning(app.get(PendingReferenceWorker))).toBe(false);
  });
});
