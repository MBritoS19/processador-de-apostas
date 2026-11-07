import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import type { SQSClient } from '@aws-sdk/client-sqs';
import type { EntityManager, MikroORM } from '@mikro-orm/postgresql';
import { randomUUID } from 'node:crypto';
import { OutboxMessage } from '../../../src/domain/outbox-message';
import { loadConfig } from '../../../src/infrastructure/config/app-config';
import { createSqsClient } from '../../../src/infrastructure/messaging/sqs.client';
import { OutboxEventsClient } from '../../../src/infrastructure/outbox/outbox-events.client';
import { OutboxStore } from '../../../src/infrastructure/outbox/outbox-store';
import { buildUseCase, command } from '../application/harness';
import { openOrm, seedWallet, truncateAll } from '../persistence/db';
import {
  ManualClock,
  SpyEvents,
  buildPublisher,
  canLock,
  captureLogger,
  createEventsQueue,
  deferred,
  deleteQueue,
  drain,
  eventually,
  insertEvents,
  killClaimSession,
  outboxRows,
  pendingCount,
  poison,
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

/** Store que lança entre a publicação e o commit nas primeiras `crashes` vezes. */
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

/** Store que conta os claims e o tamanho de cada um. */
function countingStore(base: OutboxStore, sizes: number[], failFirst = 0): OutboxStore {
  let failures = failFirst;
  return Object.assign(Object.create(base) as OutboxStore, {
    claim: async (...args: Parameters<OutboxStore['claim']>) => {
      if (failures > 0) {
        failures--;
        throw new Error('banco fora (injetado)');
      }
      const claimed = await base.claim(...args);
      sizes.push(claimed.length);
      return claimed;
    },
  });
}

/** Erro do AWS SDK atribuído ao chamador (4xx). */
function clientFault(): Error {
  return Object.assign(new Error('request inválido (injetado)'), { name: 'InvalidParameterValue', $fault: 'client' });
}

describe('outbox publisher (Postgres + LocalStack reais)', () => {
  let orm: MikroORM;
  /** Outra "instância": MikroORM com pool próprio. */
  let other: MikroORM;
  let sqs: SQSClient;
  let queue: { name: string; url: string };

  beforeAll(async () => {
    orm = await openOrm();
    other = await openOrm();
    sqs = createSqsClient(loadConfig());
  });

  afterAll(async () => {
    sqs.destroy();
    await Promise.all([orm.close(true), other.close(true)]);
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
    expect(after).toHaveLength(2);
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

  it('exceção depois de publicar e antes do commit → outra instância republica o mesmo eventId; marcado uma vez', async () => {
    const [event] = await insertEvents(orm, [randomUUID()], 1);
    const { logger } = captureLogger();
    const dying = buildPublisher(orm, sqs, queue.name, {
      store: new CrashingStore(orm.em, 1),
      wrapEvents: (real) => new SpyEvents(real),
      logger,
    });
    await expect(dying.publisher.publishOnce()).rejects.toThrow('processo morreu');
    expect((dying.events as SpyEvents).published).toEqual([event!.id]);

    // O rollback soltou o lock e não gravou nada.
    const [pending] = await outboxRows(orm);
    expect(pending?.published_at).toBeNull();
    expect(pending?.attempts).toBe(0);

    const survivor = buildPublisher(other, sqs, queue.name, { wrapEvents: (real) => new SpyEvents(real) });
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
  });

  it('conexão do publisher morta (pg_terminate_backend) depois de publicar → lock cai e outra instância republica', async () => {
    const [event] = await insertEvents(orm, [randomUUID()], 1);
    const published = deferred();
    const gate = deferred();
    const { logger } = captureLogger();
    const dying = buildPublisher(orm, sqs, queue.name, {
      logger,
      wrapEvents: (real) => ({
        async publish(messages, signal) {
          const result = await real.publish(messages, signal);
          published.resolve();
          await gate.promise;
          return result;
        },
      }),
    });

    const cycle = dying.publisher.publishOnce();
    await published.promise;
    expect(await killClaimSession(other)).toBe(1);
    gate.resolve();
    await expect(cycle).rejects.toThrow();

    const [pending] = await outboxRows(other);
    expect(pending?.published_at).toBeNull();
    expect(pending?.attempts).toBe(0);

    const survivor = buildPublisher(other, sqs, queue.name, { wrapEvents: (real) => new SpyEvents(real) });
    expect(await survivor.publisher.publishOnce()).toBe(1);
    expect((survivor.events as SpyEvents).published).toEqual([event!.id]);
    const rows = await outboxRows(other);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.published_at).toBeInstanceOf(Date);
    expect(new Set((await drain(sqs, queue.url)).map((m) => m.body.eventId))).toEqual(new Set([event!.id]));
  });

  it('SQS falhando → attempts e next_attempt_at com backoff 1s, 2s, 4s (valores gravados); quando volta, publica', async () => {
    const clock = new ManualClock(T);
    let down = true;
    const { logger } = captureLogger();
    const { publisher, events, metrics } = buildPublisher(orm, sqs, queue.name, {
      clock,
      logger,
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
    const { logger } = captureLogger();
    const { publisher } = buildPublisher(orm, sqs, 'nao-existe-outbox.fifo', { clock, logger });
    await insertEvents(orm, [randomUUID()], 1, T);

    expect(await publisher.publishOnce()).toBe(1);
    const [row] = await outboxRows(orm);
    expect(row?.published_at).toBeNull();
    expect(row?.attempts).toBe(1);
    expect(row?.next_attempt_at?.toISOString()).toBe('2026-11-07T15:00:01.000Z');
  });

  it('cliente real repassa o abortSignal ao SQS: chamada abortada não publica', async () => {
    const [warm, aborted] = await insertEvents(orm, [randomUUID(), randomUUID()], 1);
    const rows = await outboxRows(orm);
    const message = (id: string) => {
      const row = rows.find((r) => r.id === id)!;
      return OutboxMessage.rehydrate({
        id: row.id,
        aggregateId: row.aggregate_id,
        eventType: 'WalletBalanceChanged',
        payload: row.payload,
        occurredAt: T,
        attempts: 0,
      });
    };
    const client = new OutboxEventsClient(sqs, queue.name);
    // Primeiro envio resolve a URL da fila; o segundo vai direto ao SendMessageBatch, já abortado.
    await client.publish([message(warm!.id)], new AbortController().signal);
    await expect(client.publish([message(aborted!.id)], AbortSignal.abort())).rejects.toThrow();

    expect((await drain(sqs, queue.url)).map((m) => m.body.eventId)).toEqual([warm!.id]);
  });

  it('SQS lento → a chamada é abortada no timeout e o evento vai para retry', async () => {
    const clock = new ManualClock(T);
    const hanging = {
      publish: (_messages: readonly OutboxMessage[], signal: AbortSignal) =>
        new Promise<never>((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason))),
    };
    const { logger } = captureLogger();
    const { publisher, metrics } = buildPublisher(orm, sqs, queue.name, {
      clock,
      logger,
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
  });

  it('publisher travado com o lock → idle_in_transaction_session_timeout derruba a sessão e outra instância publica', async () => {
    const [event] = await insertEvents(orm, [randomUUID()], 1);
    const started = deferred();
    const gate = deferred();
    const { logger } = captureLogger();
    const stuck = buildPublisher(orm, sqs, queue.name, {
      logger,
      store: new OutboxStore(orm.em, 1_000),
      options: { sqsTimeoutMs: 60_000 },
      wrapEvents: () => ({
        async publish() {
          started.resolve();
          await gate.promise;
          throw new Error('nunca respondeu');
        },
      }),
    });

    const cycle = stuck.publisher.publishOnce();
    await started.promise;
    expect(await canLock(other, event!.id)).toBe(false);
    // Sem sleep fixo: o lock cai em ~1s (timeout do teste), bem antes do prazo do eventually.
    await eventually(async () => expect(await canLock(other, event!.id)).toBe(true), 5_000);

    const [pending] = await outboxRows(other);
    expect(pending?.published_at).toBeNull();
    expect(pending?.attempts).toBe(0);
    const survivor = buildPublisher(other, sqs, queue.name);
    expect(await survivor.publisher.publishOnce()).toBe(1);

    gate.resolve();
    await expect(cycle).rejects.toThrow();
    expect((await outboxRows(other))[0]?.published_at).toBeInstanceOf(Date);
  });

  it('falha parcial real no SendMessageBatch (InvalidMessageContents) → só a entrada recusada vai para retry', async () => {
    const clock = new ManualClock(T);
    const events = await insertEvents(orm, [randomUUID(), randomUUID(), randomUUID()], 1, T);
    const rejected = events[1]!.id;
    await poison(orm, rejected);
    const { logger, lines } = captureLogger();
    const { publisher, metrics } = buildPublisher(orm, sqs, queue.name, { clock, logger });

    expect(await publisher.publishOnce()).toBe(3);
    const rows = await outboxRows(orm);
    expect(rows).toHaveLength(3);
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
    expect(lines.filter((l) => l.event === 'outbox_entry_failed')).toEqual([
      expect.objectContaining({ eventId: rejected, code: 'InvalidMessageContents' }),
    ]);
    expect(await counterValue(metrics.outboxPublishFailures, { scope: 'entry' })).toBe(1);
    expect(await counterValue(metrics.outboxPublishFailures, { scope: 'batch' })).toBe(0);
    expect(await counterValue(metrics.outboxRetries)).toBe(1);
    expect(await counterValue(metrics.outboxPublished)).toBe(2);
  });

  it('lote inteiro recusado por erro do cliente (4xx) → reenvia um a um; só a entrada culpada fica para retry', async () => {
    const clock = new ManualClock(T);
    const events = await insertEvents(orm, [randomUUID(), randomUUID(), randomUUID()], 1, T);
    const culprit = events[1]!.id;
    const { logger } = captureLogger();
    const { publisher, events: spy } = buildPublisher(orm, sqs, queue.name, {
      clock,
      logger,
      wrapEvents: (real) => {
        const spyEvents = new SpyEvents(real);
        return {
          calls: spyEvents.calls,
          async publish(messages: readonly OutboxMessage[], signal: AbortSignal) {
            if (messages.some((m) => m.id === culprit)) {
              spyEvents.calls.push(messages.map((m) => m.id));
              throw clientFault();
            }
            return spyEvents.publish(messages, signal);
          },
        };
      },
    });

    expect(await publisher.publishOnce()).toBe(3);
    const calls = (spy as unknown as { calls: string[][] }).calls;
    expect(calls).toEqual([events.map((e) => e.id), [events[0]!.id], [culprit], [events[2]!.id]]);
    const rows = await outboxRows(orm);
    expect(rows.filter((r) => r.published_at === null).map((r) => r.id)).toEqual([culprit]);
    expect(rows.find((r) => r.id === culprit)?.attempts).toBe(1);
    expect(new Set((await drain(sqs, queue.url)).map((m) => m.body.eventId))).toEqual(
      new Set([events[0]!.id, events[2]!.id]),
    );
  });

  it('lote inteiro falha por erro do servidor ou rede → não reenvia um a um; todos vão para retry', async () => {
    const clock = new ManualClock(T);
    await insertEvents(orm, [randomUUID(), randomUUID()], 1, T);
    const { logger } = captureLogger();
    const { publisher, events } = buildPublisher(orm, sqs, queue.name, {
      clock,
      logger,
      wrapEvents: (real) => new SpyEvents(real, () => 'throw'),
    });

    expect(await publisher.publishOnce()).toBe(2);
    expect((events as SpyEvents).calls).toHaveLength(1);
    expect((await outboxRows(orm)).map((r) => r.attempts)).toEqual([1, 1]);
  });

  it('evento que atinge OUTBOX_STUCK_ATTEMPTS → log error outbox_event_stuck, com o código da falha', async () => {
    const clock = new ManualClock(T);
    const [batchFailed, entryFailed] = await insertEvents(orm, [randomUUID(), randomUUID()], 1, T);
    await orm.em.fork().execute('update outbox_messages set attempts = 9');
    await poison(orm, entryFailed!.id);
    const { logger, lines } = captureLogger();
    const stuckLines = () => lines.filter((l) => l.event === 'outbox_event_stuck');

    // Falha do lote inteiro (só o 1º evento no lote).
    const down = buildPublisher(orm, sqs, queue.name, {
      clock,
      logger,
      options: { batchSize: 1 },
      wrapEvents: (real) => new SpyEvents(real, () => 'throw'),
    });
    await down.publisher.publishOnce();
    expect(stuckLines()).toEqual([
      expect.objectContaining({ level: 50, eventId: batchFailed!.id, attempts: 10, code: 'batch_failed' }),
    ]);

    // Falha real por entrada (InvalidMessageContents).
    const real = buildPublisher(orm, sqs, queue.name, { clock, logger });
    await real.publisher.publishOnce();
    expect(stuckLines()[1]).toEqual(
      expect.objectContaining({ level: 50, eventId: entryFailed!.id, attempts: 10, code: 'InvalidMessageContents' }),
    );
    expect(stuckLines()).toHaveLength(2);
  });

  it('uma wallet com 50 WalletBalanceChanged → todos saem em ordem, um por ciclo, sem esperar o intervalo entre eles', async () => {
    const aggregate = randomUUID();
    const events = await insertEvents(orm, [aggregate], 50);
    const claims: number[] = [];
    // Intervalo de 60s: qualquer espera depois de um claim não vazio estouraria o eventually.
    const { publisher } = buildPublisher(orm, sqs, queue.name, {
      store: countingStore(new OutboxStore(orm.em, 15_000), claims),
      options: { pollIntervalMs: 60_000 },
    });

    const started = Date.now();
    publisher.start();
    await eventually(async () => expect(await pendingCount(orm)).toBe(0));
    const elapsed = Date.now() - started;
    await publisher.stop();

    expect(elapsed).toBeLessThan(10_000);
    // Um por ciclo (só o primeiro pendente do agregado é elegível), sem ciclo vazio no meio.
    expect(claims.slice(0, 50)).toEqual(Array.from({ length: 50 }, () => 1));

    const rows = await outboxRows(orm);
    expect(rows).toHaveLength(50);
    const publishedAt = rows.map((row) => row.published_at!.getTime());
    expect(publishedAt).toEqual([...publishedAt].sort((a, b) => a - b));
    const received = await drain(sqs, queue.url);
    expect(received.map((m) => m.body.eventId)).toEqual(events.map((e) => e.id));
  });

  it('stop() interrompe a espera do intervalo na hora', async () => {
    const claims: number[] = [];
    const { publisher } = buildPublisher(orm, sqs, queue.name, {
      store: countingStore(new OutboxStore(orm.em, 15_000), claims),
      options: { pollIntervalMs: 60_000 },
    });
    publisher.start();
    await eventually(() => expect(claims).toEqual([0]));

    const started = Date.now();
    await publisher.stop();
    expect(Date.now() - started).toBeLessThan(500);
  });

  it('falha do ciclo (banco fora) → log outbox_cycle_failed, pausa e o loop segue publicando', async () => {
    await insertEvents(orm, [randomUUID()], 1);
    const claims: number[] = [];
    const { logger, lines } = captureLogger();
    const { publisher } = buildPublisher(orm, sqs, queue.name, {
      logger,
      store: countingStore(new OutboxStore(orm.em, 15_000), claims, 1),
    });

    publisher.start();
    await eventually(async () => expect(await pendingCount(orm)).toBe(0), 5_000);
    await publisher.stop();
    expect(lines.filter((l) => l.event === 'outbox_cycle_failed')).toEqual([
      expect.objectContaining({ level: 50, pauseMs: 1_000 }),
    ]);
  });

  it('save só grava linha pendente: se uma já foi publicada, aborta e desfaz o lote inteiro', async () => {
    const [first, second] = await insertEvents(orm, [randomUUID(), randomUUID()], 1, T);
    const rows = await outboxRows(orm);
    const toMessage = (id: string) => {
      const row = rows.find((r) => r.id === id)!;
      return OutboxMessage.rehydrate({
        id: row.id,
        aggregateId: row.aggregate_id,
        eventType: 'WalletBalanceChanged',
        payload: row.payload,
        occurredAt: T,
        attempts: 0,
      });
    };
    const messages = [toMessage(first!.id), toMessage(second!.id)];
    for (const message of messages) message.markPublished(T);
    await orm.em.fork().execute('update outbox_messages set published_at = ? where id = ?', [T, second!.id]);

    const store = new OutboxStore(orm.em, 15_000);
    await expect(orm.em.fork().transactional((em) => store.save(em, messages))).rejects.toThrow('não estava pendente');
    expect((await outboxRows(orm)).find((r) => r.id === first!.id)?.published_at).toBeNull();
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
    const gate = deferred();
    const started = deferred();
    const claims: number[] = [];
    const { publisher } = buildPublisher(orm, sqs, queue.name, {
      store: countingStore(new OutboxStore(orm.em, 15_000), claims),
      wrapEvents: (real) => ({
        async publish(messages, signal) {
          started.resolve();
          await gate.promise;
          return real.publish(messages, signal);
        },
      }),
    });

    publisher.start();
    await started.promise;
    let stopped = false;
    const stopping = publisher.stop().then(() => (stopped = true));
    // O stop espera o lote: ainda não terminou enquanto a publicação está travada.
    await Promise.resolve();
    expect(stopped).toBe(false);

    gate.resolve();
    await stopping;
    expect(await pendingCount(orm)).toBe(0);
    expect(claims).toEqual([1]);
    expect((await drain(sqs, queue.url)).length).toBe(1);
  });

  it('shutdown estoura o prazo → stop() volta no timeout; a sessão cai e outra instância publica o lote', async () => {
    const [event] = await insertEvents(orm, [randomUUID()], 1);
    const gate = deferred();
    const started = deferred();
    const { logger, lines } = captureLogger();
    const { publisher } = buildPublisher(orm, sqs, queue.name, {
      logger,
      store: new OutboxStore(orm.em, 1_000),
      options: { shutdownTimeoutMs: 200, sqsTimeoutMs: 60_000 },
      wrapEvents: () => ({
        async publish() {
          started.resolve();
          await gate.promise;
          throw new Error('nunca respondeu');
        },
      }),
    });

    publisher.start();
    await started.promise;
    const stopStarted = Date.now();
    await publisher.stop();
    expect(Date.now() - stopStarted).toBeLessThan(1_000);
    expect(lines.some((l) => l.event === 'outbox_publisher_shutdown_timeout')).toBe(true);

    // O lote abandonado não commitou: o lock cai (idle timeout) e a outra instância publica.
    const survivor = buildPublisher(other, sqs, queue.name);
    await eventually(async () => expect(await survivor.publisher.publishOnce()).toBe(1), 5_000);
    expect(new Set((await drain(sqs, queue.url)).map((m) => m.body.eventId))).toEqual(new Set([event!.id]));

    gate.resolve();
    await publisher.stop();
  });
});
