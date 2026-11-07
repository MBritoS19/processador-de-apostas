import 'reflect-metadata';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import type { SQSClient } from '@aws-sdk/client-sqs';
import type { MikroORM } from '@mikro-orm/postgresql';
import { Test } from '@nestjs/testing';
import { randomUUID } from 'node:crypto';
import { AppModule } from '../../../src/app.module';
import { loadConfig, type AppConfig } from '../../../src/infrastructure/config/app-config';
import { createSqsClient } from '../../../src/infrastructure/messaging/sqs.client';
import { OutboxPublisher } from '../../../src/interfaces/workers/outbox-publisher';
import { openOrm, truncateAll } from '../persistence/db';
import { createEventsQueue, deleteQueue, drain, eventually, insertEvents, pendingCount } from './outbox-harness';

/** Aplicação Nest inteira: a flag liga o loop e o shutdown da aplicação para o publisher. */
describe('OutboxPublisherModule', () => {
  let orm: MikroORM;
  let sqs: SQSClient;

  beforeAll(async () => {
    orm = await openOrm();
    sqs = createSqsClient(loadConfig());
  });

  afterAll(async () => {
    sqs.destroy();
    await orm.close(true);
  });

  beforeEach(async () => {
    await truncateAll(orm);
  });

  async function startApp(enabled: boolean, queueName: string) {
    const base = loadConfig();
    const config: AppConfig = {
      ...base,
      sqs: { ...base.sqs, wagerEventsQueueName: queueName },
      outboxPublisher: { ...base.outboxPublisher, enabled, pollIntervalMs: 50 },
    };
    const moduleRef = await Test.createTestingModule({ imports: [AppModule.register(config)] }).compile();
    const app = moduleRef.createNestApplication({ logger: false });
    await app.init();
    return app;
  }

  /** `stop()` devolve na hora quando não há loop; com loop, só depois de ele terminar. */
  const isRunning = (publisher: OutboxPublisher) => (publisher as unknown as { loop?: Promise<void> }).loop !== undefined;

  it('OUTBOX_PUBLISHER_ENABLED=true → publica a outbox; app.close() para o loop', async () => {
    const queue = await createEventsQueue(sqs);
    try {
      const [event] = await insertEvents(orm, [randomUUID()], 1);
      const app = await startApp(true, queue.name);
      const publisher = app.get(OutboxPublisher);
      expect(isRunning(publisher)).toBe(true);

      await eventually(async () => expect(await pendingCount(orm)).toBe(0));
      await app.close();
      expect(isRunning(publisher)).toBe(false);
      expect((await drain(sqs, queue.url)).map((m) => m.body.eventId)).toEqual([event!.id]);
    } finally {
      await deleteQueue(sqs, queue.url);
    }
  });

  it('OUTBOX_PUBLISHER_ENABLED=false → o loop não inicia', async () => {
    const queue = await createEventsQueue(sqs);
    try {
      await insertEvents(orm, [randomUUID()], 1);
      const app = await startApp(false, queue.name);
      expect(isRunning(app.get(OutboxPublisher))).toBe(false);
      await app.close();
      expect(await pendingCount(orm)).toBe(1);
    } finally {
      await deleteQueue(sqs, queue.url);
    }
  });
});
