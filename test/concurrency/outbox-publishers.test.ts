import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import type { SQSClient } from '@aws-sdk/client-sqs';
import type { MikroORM } from '@mikro-orm/postgresql';
import { randomUUID } from 'node:crypto';
import { loadConfig } from '../../src/infrastructure/config/app-config';
import { createSqsClient } from '../../src/infrastructure/messaging/sqs.client';
import { openOrm, truncateAll } from '../integration/persistence/db';
import {
  SpyEvents,
  buildPublisher,
  createEventsQueue,
  deleteQueue,
  drain,
  eventually,
  insertEvents,
  outboxRows,
  pendingCount,
} from '../integration/workers/outbox-harness';

/** Dois publishers, cada um com seu MikroORM (pool próprio), como duas instâncias. */
describe('publishers concorrentes sobre a mesma outbox', () => {
  let orms: MikroORM[];
  let sqs: SQSClient;
  let queue: { name: string; url: string };

  beforeAll(async () => {
    orms = [await openOrm(), await openOrm()];
    sqs = createSqsClient(loadConfig());
  });

  afterAll(async () => {
    sqs.destroy();
    await Promise.all(orms.map((orm) => orm.close(true)));
  });

  beforeEach(async () => {
    await truncateAll(orms[0]!);
    queue = await createEventsQueue(sqs);
  });

  afterEach(async () => {
    await deleteQueue(sqs, queue.url);
  });

  it('300 eventos em 30 agregados → todos publicados, nenhum perdido, cada agregado em ordem', async () => {
    const aggregates = Array.from({ length: 30 }, () => randomUUID());
    const events = await insertEvents(orms[0]!, aggregates, 10);
    expect(events).toHaveLength(300);
    const fixtures = orms.map((orm) => buildPublisher(orm, sqs, queue.name, { wrapEvents: (real) => new SpyEvents(real) }));

    for (const { publisher } of fixtures) publisher.start();
    await eventually(async () => expect(await pendingCount(orms[0]!)).toBe(0), 60_000);
    await Promise.all(fixtures.map(({ publisher }) => publisher.stop()));

    // Os dois trabalharam, e nenhum evento foi aceito duas vezes (o lock serializa).
    const spies = fixtures.map(({ events: spy }) => spy as SpyEvents);
    for (const spy of spies) expect(spy.published.length).toBeGreaterThan(0);
    const accepted = spies.flatMap((spy) => spy.published);
    expect(accepted).toHaveLength(300);
    expect(new Set(accepted).size).toBe(300);

    const received = await drain(sqs, queue.url);
    const distinct = new Set(received.map((m) => m.body.eventId as string));
    expect(distinct.size).toBe(300);
    expect(distinct).toEqual(new Set(events.map((e) => e.id)));

    // Ordem por agregado: na fila (grupo = aggregateId) e no published_at.
    for (const aggregateId of aggregates) {
      const positions = received.filter((m) => m.groupId === aggregateId).map((m) => (m.body.data as { position: number }).position);
      expect(positions).toEqual(Array.from({ length: 10 }, (_, i) => i + 1));
    }
    const rows = await outboxRows(orms[0]!);
    for (const aggregateId of aggregates) {
      const times = rows.filter((row) => row.aggregate_id === aggregateId).map((row) => row.published_at!.getTime());
      expect(times).toEqual([...times].sort((a, b) => a - b));
    }
  });

  it('falha no 1º evento de uma wallet → o 2º não sai antes dele, mesmo com dois publishers', async () => {
    const blocked = randomUUID();
    const free = randomUUID();
    const events = await insertEvents(orms[0]!, [blocked, free], 2);
    const first = events.find((e) => e.aggregateId === blocked && e.position === 1)!;
    const second = events.find((e) => e.aggregateId === blocked && e.position === 2)!;

    // O 1º evento da wallet é recusado nas 2 primeiras tentativas (backoff real: 1s + 2s).
    let refusals = 0;
    const fault = (messages: readonly { id: string }[]) => {
      if (refusals < 2 && messages.some((m) => m.id === first.id)) {
        refusals++;
        return new Set([first.id]);
      }
      return undefined;
    };
    const fixtures = orms.map((orm) => buildPublisher(orm, sqs, queue.name, { wrapEvents: (real) => new SpyEvents(real, fault) }));
    const spies = fixtures.map(({ events: spy }) => spy as SpyEvents);

    for (const { publisher } of fixtures) publisher.start();
    // O outro agregado não é bloqueado pela falha.
    await eventually(async () => {
      const rows = await outboxRows(orms[0]!);
      expect(rows.filter((r) => r.aggregate_id === free).every((r) => r.published_at !== null)).toBe(true);
    });
    const midway = await outboxRows(orms[0]!);
    expect(midway.find((r) => r.id === first.id)?.published_at).toBeNull();
    expect(midway.find((r) => r.id === second.id)?.published_at).toBeNull();

    await eventually(async () => expect(await pendingCount(orms[0]!)).toBe(0), 30_000);
    await Promise.all(fixtures.map(({ publisher }) => publisher.stop()));

    expect(refusals).toBe(2);
    // O 2º nunca foi nem enviado antes de o 1º ser aceito.
    const sentOrder = spies.flatMap((spy) => spy.calls.flat());
    expect(sentOrder.filter((id) => id === second.id)).toHaveLength(1);
    const rows = await outboxRows(orms[0]!);
    const firstRow = rows.find((r) => r.id === first.id)!;
    const secondRow = rows.find((r) => r.id === second.id)!;
    expect(firstRow.attempts).toBe(2);
    expect(secondRow.attempts).toBe(0);
    expect(secondRow.published_at!.getTime()).toBeGreaterThan(firstRow.published_at!.getTime());

    const received = await drain(sqs, queue.url);
    const blockedOrder = received.filter((m) => m.groupId === blocked).map((m) => m.body.eventId);
    expect(blockedOrder).toEqual([first.id, second.id]);
  });
});
