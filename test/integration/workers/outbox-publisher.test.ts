import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import type { SQSClient } from '@aws-sdk/client-sqs';
import type { EntityManager, MikroORM } from '@mikro-orm/postgresql';
import { randomUUID } from 'node:crypto';
import type { OutboxMessage } from '../../../src/domain/outbox-message';
import { loadConfig } from '../../../src/infrastructure/config/app-config';
import { createSqsClient } from '../../../src/infrastructure/messaging/sqs.client';
import { OutboxStore } from '../../../src/infrastructure/outbox/outbox-store';
import { buildUseCase, command } from '../application/harness';
import { openOrm, seedWallet, truncateAll } from '../persistence/db';
import {
  ManualClock,
  SpyEvents,
  buildPublisher,
  createEventsQueue,
  deleteQueue,
  drain,
  eventually,
  insertEvents,
  outboxRows,
  pendingCount,
} from './outbox-harness';

const T = new Date('2026-11-07T15:00:00.000Z');

async function gaugeValue(gauge: { get(): Promise<{ values: Array<{ value: number }> }> }): Promise<number> {
  return (await gauge.get()).values[0]?.value ?? Number.NaN;
}

async function counterValue(
  counter: { get(): Promise<{ values: Array<{ value: number; labels: Record<string, unknown> }> }> },
  labels: Record<string, string> = {},
): Promise<number> {
  const { values } = await counter.get();
  return values
    .filter((v) => Object.entries(labels).every(([key, value]) => v.labels[key] === value))
    .reduce((sum, v) => sum + v.value, 0);
}

/** Store que "morre" entre a publicação e o commit nas primeiras `crashes` vezes. */
class CrashingStore extends OutboxStore {
  crashes: number;
  constructor(em: EntityManager, crashes: number) {
    super(em, 15_000);
    this.crashes = crashes;
  }
  override async save(em: EntityManager, messages: readonly OutboxMessage[]): Promise<void> {
    if (this.crashes > 0) {
      this.crashes--;
      throw new Error('processo morreu antes do commit (injetado)');
    }
    return super.save(em, messages);
  }
}

describe('outbox publisher (Postgres + LocalStack reais)', () => {
  let orm: MikroORM;
  let sqs: SQSClient;
  let queue: { name: string; url: string };

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
    queue = await createEventsQueue(sqs);
  });

  afterEach(async () => {
    await deleteQueue(sqs, queue.url);
  });

  it('evento gravado pela transação financeira → publicado com o envelope exato, grupo = aggregateId, dedup = eventId', async () => {
    const wallet = await seedWallet(orm, '100.00');
    const { useCase } = buildUseCase(orm);
    expect((await useCase.execute(command(wallet))).type).toBe('Processed');
    const before = await outboxRows(orm);
    expect(before).toHaveLength(2);

    const { publisher, metrics } = buildPublisher(orm, sqs, queue.name);
    expect(await publisher.publishOnce()).toBe(2);

    const after = await outboxRows(orm);
    for (const row of after) {
      expect(row.published_at).toBeInstanceOf(Date);
      expect(row.attempts).toBe(0);
      expect(row.next_attempt_at).toBeNull();
    }
    const received = await drain(sqs, queue.url);
    expect(received).toHaveLength(2);
    for (const row of before) {
      const message = received.find((m) => m.body.eventId === row.id);
      expect(message?.body).toEqual(row.payload);
      expect(message?.groupId).toBe(row.aggregate_id);
      expect(message?.dedupId).toBe(row.id);
    }
    expect(await counterValue(metrics.outboxPublished)).toBe(2);
    expect(await publisher.publishOnce()).toBe(0);
  });

  it('processo morre depois de publicar e antes do commit → outra instância republica o mesmo eventId; marcado uma vez', async () => {
    const [event] = await insertEvents(orm, [randomUUID()], 1);
    const otherOrm = await openOrm();
    try {
      const dying = buildPublisher(orm, sqs, queue.name, {
        store: new CrashingStore(orm.em, 1),
        wrapEvents: (real) => new SpyEvents(real),
      });
      await expect(dying.publisher.publishOnce()).rejects.toThrow('processo morreu');
      expect((dying.events as SpyEvents).published).toEqual([event!.id]);

      // O rollback soltou o lock e não gravou nada.
      const [pending] = await outboxRows(orm);
      expect(pending?.published_at).toBeNull();
      expect(pending?.attempts).toBe(0);

      const survivor = buildPublisher(otherOrm, sqs, queue.name, { wrapEvents: (real) => new SpyEvents(real) });
      expect(await survivor.publisher.publishOnce()).toBe(1);
      expect((survivor.events as SpyEvents).published).toEqual([event!.id]);

      const rows = await outboxRows(orm);
      expect(rows).toHaveLength(1);
      expect(rows[0]?.published_at).toBeInstanceOf(Date);
      expect(rows[0]?.attempts).toBe(0);
      // Duas publicações, mesmo eventId: o broker pode deduplicar; o consumidor deduplica por eventId.
      const received = await drain(sqs, queue.url);
      expect(received.length).toBeGreaterThanOrEqual(1);
      expect(new Set(received.map((m) => m.body.eventId))).toEqual(new Set([event!.id]));
      expect(await survivor.publisher.publishOnce()).toBe(0);
    } finally {
      await otherOrm.close(true);
    }
  });

  it('SQS falhando → attempts e next_attempt_at com backoff 1s, 2s, 4s (valores gravados); quando volta, publica', async () => {
    const clock = new ManualClock(T);
    let down = true;
    const { publisher, events, metrics } = buildPublisher(orm, sqs, queue.name, {
      clock,
      wrapEvents: (real) => new SpyEvents(real, () => (down ? 'throw' : undefined)),
    });
    const [event] = await insertEvents(orm, [randomUUID()], 1, T);
    const state = async () => {
      const [row] = await outboxRows(orm);
      return { attempts: row?.attempts, next: row?.next_attempt_at?.toISOString(), published: row?.published_at !== null };
    };

    expect(await publisher.publishOnce()).toBe(1);
    expect(await state()).toEqual({ attempts: 1, next: '2026-11-07T15:00:01.000Z', published: false });

    // Ainda não venceu: nem é reivindicado.
    expect(await publisher.publishOnce()).toBe(0);
    expect((events as SpyEvents).calls).toHaveLength(1);

    clock.advance(1_000);
    await publisher.publishOnce();
    expect(await state()).toEqual({ attempts: 2, next: '2026-11-07T15:00:03.000Z', published: false });

    clock.advance(2_000);
    await publisher.publishOnce();
    expect(await state()).toEqual({ attempts: 3, next: '2026-11-07T15:00:07.000Z', published: false });

    down = false;
    clock.advance(4_000);
    expect(await publisher.publishOnce()).toBe(1);
    expect(await state()).toEqual({ attempts: 3, next: undefined, published: true });
    expect((await drain(sqs, queue.url)).map((m) => m.body.eventId)).toEqual([event!.id]);
    expect(await counterValue(metrics.outboxRetries)).toBe(3);
    expect(await counterValue(metrics.outboxPublishFailures, { scope: 'batch' })).toBe(3);
    expect(await counterValue(metrics.outboxPublished)).toBe(1);
  });

  it('fila inexistente (erro real do SQS) → retry, nunca descarte', async () => {
    const clock = new ManualClock(T);
    const { publisher } = buildPublisher(orm, sqs, 'nao-existe-outbox.fifo', { clock });
    await insertEvents(orm, [randomUUID()], 1, T);

    expect(await publisher.publishOnce()).toBe(1);
    const [row] = await outboxRows(orm);
    expect(row?.published_at).toBeNull();
    expect(row?.attempts).toBe(1);
    expect(row?.next_attempt_at?.toISOString()).toBe('2026-11-07T15:00:01.000Z');
  });

  it('SQS lento → a chamada é abortada no timeout, o evento vai para retry e o lock é solto', async () => {
    const clock = new ManualClock(T);
    const hanging = {
      publish: (_messages: readonly OutboxMessage[], signal: AbortSignal) =>
        new Promise<never>((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason))),
    };
    const { publisher, metrics } = buildPublisher(orm, sqs, queue.name, {
      clock,
      options: { sqsTimeoutMs: 300 },
      wrapEvents: () => hanging,
    });
    await insertEvents(orm, [randomUUID()], 1, T);

    const started = Date.now();
    expect(await publisher.publishOnce()).toBe(1);
    expect(Date.now() - started).toBeLessThan(2_000);
    const [row] = await outboxRows(orm);
    expect(row?.attempts).toBe(1);
    expect(row?.published_at).toBeNull();
    expect(await counterValue(metrics.outboxPublishFailures, { scope: 'batch' })).toBe(1);
    // Lock solto: outra transação trava a linha sem esperar.
    await orm.em.fork().transactional(async (em) => {
      const locked = await em.execute('select id from outbox_messages for update nowait');
      expect(locked).toHaveLength(1);
    });
  });

  it('falha parcial no SendMessageBatch → só as entradas recusadas vão para retry', async () => {
    const clock = new ManualClock(T);
    const events = await insertEvents(orm, [randomUUID(), randomUUID(), randomUUID()], 1, T);
    const rejected = events[1]!.id;
    const { publisher, metrics } = buildPublisher(orm, sqs, queue.name, {
      clock,
      wrapEvents: (real) => new SpyEvents(real, () => new Set([rejected])),
    });

    expect(await publisher.publishOnce()).toBe(3);
    const rows = await outboxRows(orm);
    for (const row of rows) {
      if (row.id === rejected) {
        expect(row.published_at).toBeNull();
        expect(row.attempts).toBe(1);
        expect(row.next_attempt_at?.toISOString()).toBe('2026-11-07T15:00:01.000Z');
      } else {
        expect(row.published_at).toBeInstanceOf(Date);
        expect(row.attempts).toBe(0);
      }
    }
    const received = await drain(sqs, queue.url);
    expect(new Set(received.map((m) => m.body.eventId))).toEqual(new Set([events[0]!.id, events[2]!.id]));
    expect(await counterValue(metrics.outboxPublishFailures, { scope: 'entry' })).toBe(1);
    expect(await counterValue(metrics.outboxRetries)).toBe(1);
    expect(await counterValue(metrics.outboxPublished)).toBe(2);
  });

  it('uma wallet com 50 WalletBalanceChanged → todos saem em ordem, um por ciclo, sem esperar o intervalo entre eles', async () => {
    const aggregate = randomUUID();
    const events = await insertEvents(orm, [aggregate], 50);
    const store = new OutboxStore(orm.em, 15_000);
    const claims: number[] = [];
    const countingStore = Object.assign(Object.create(store) as OutboxStore, {
      claim: async (...args: Parameters<OutboxStore['claim']>) => {
        const claimed = await store.claim(...args);
        claims.push(claimed.length);
        return claimed;
      },
    });
    const { publisher } = buildPublisher(orm, sqs, queue.name, { store: countingStore, options: { pollIntervalMs: 500 } });

    const started = Date.now();
    publisher.start();
    await eventually(async () => expect(await pendingCount(orm)).toBe(0));
    const elapsed = Date.now() - started;
    await publisher.stop();

    // Com uma espera de 500ms por evento seriam ≥ 25s.
    expect(elapsed).toBeLessThan(10_000);
    // Um por ciclo (só o primeiro pendente do agregado é elegível), sem ciclo vazio no meio.
    expect(claims.slice(0, 50)).toEqual(Array.from({ length: 50 }, () => 1));

    const rows = await outboxRows(orm);
    const publishedAt = rows.map((row) => row.published_at!.getTime());
    expect(publishedAt).toEqual([...publishedAt].sort((a, b) => a - b));
    const received = await drain(sqs, queue.url);
    expect(received.map((m) => m.body.eventId)).toEqual(events.map((e) => e.id));
  });

  it('outbox lag e eventos travados: gauges medidos a partir do pendente mais antigo', async () => {
    const clock = new ManualClock(T);
    const aggregate = randomUUID();
    await insertEvents(orm, [aggregate], 2, new Date(T.getTime() - 30_000));
    await orm.em
      .fork()
      .execute('update outbox_messages set attempts = 12, next_attempt_at = ? where seq = (select min(seq) from outbox_messages)', [
        new Date(T.getTime() + 60_000),
      ]);
    const { publisher, metrics } = buildPublisher(orm, sqs, queue.name, { clock });

    publisher.start();
    await eventually(async () => expect(await gaugeValue(metrics.outboxStuck)).toBe(1));
    await publisher.stop();

    expect(await gaugeValue(metrics.outboxLag)).toBe(30);
    // O 2º evento do agregado fica bloqueado atrás do travado.
    expect(await pendingCount(orm)).toBe(2);

    await truncateAll(orm);
    publisher.start();
    await eventually(async () => expect(await gaugeValue(metrics.outboxLag)).toBe(0));
    await publisher.stop();
    expect(await gaugeValue(metrics.outboxStuck)).toBe(0);
  });

  it('shutdown com lote em andamento → para de buscar e commita o lote antes de terminar', async () => {
    await insertEvents(orm, [randomUUID()], 1);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => (markStarted = resolve));
    const { publisher, store } = buildPublisher(orm, sqs, queue.name, {
      wrapEvents: (real) => ({
        async publish(messages, signal) {
          markStarted();
          await gate;
          return real.publish(messages, signal);
        },
      }),
    });
    let claims = 0;
    const realClaim = store.claim.bind(store);
    store.claim = async (...args) => {
      claims++;
      return realClaim(...args);
    };

    publisher.start();
    await started;
    let stopped = false;
    const stopping = publisher.stop().then(() => (stopped = true));
    await Bun.sleep(100);
    expect(stopped).toBe(false);

    release();
    await stopping;
    expect(await pendingCount(orm)).toBe(0);
    expect(claims).toBe(1);
    expect((await drain(sqs, queue.url)).length).toBe(1);
  });
});
