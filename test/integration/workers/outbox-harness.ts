import {
  CreateQueueCommand,
  DeleteMessageBatchCommand,
  DeleteQueueCommand,
  ReceiveMessageCommand,
  type SQSClient,
} from '@aws-sdk/client-sqs';
import type { MikroORM } from '@mikro-orm/postgresql';
import pino, { type Logger } from 'pino';
import { randomUUID } from 'node:crypto';
import type { Clock } from '../../../src/application/ports/clock';
import type { OutboxMessage } from '../../../src/domain/outbox-message';
import { ObservabilityMetrics } from '../../../src/infrastructure/observability/metrics';
import { OutboxEventsClient, type PublishResult } from '../../../src/infrastructure/outbox/outbox-events.client';
import { OutboxStore } from '../../../src/infrastructure/outbox/outbox-store';
import { systemClock } from '../../../src/infrastructure/system-adapters';
import { OutboxPublisher, type OutboxPublisherOptions } from '../../../src/interfaces/workers/outbox-publisher';

/** Fila de eventos própria do teste (LocalStack real), com os atributos do init. */
export async function createEventsQueue(sqs: SQSClient): Promise<{ name: string; url: string }> {
  const name = `test-events-${randomUUID().slice(0, 8)}.fifo`;
  const { QueueUrl } = await sqs.send(
    new CreateQueueCommand({ QueueName: name, Attributes: { FifoQueue: 'true', ContentBasedDeduplication: 'false' } }),
  );
  if (!QueueUrl) throw new Error('fila de teste sem URL');
  return { name, url: QueueUrl };
}

export async function deleteQueue(sqs: SQSClient, url: string): Promise<void> {
  await sqs.send(new DeleteQueueCommand({ QueueUrl: url }));
}

export interface ReceivedEvent {
  body: Record<string, unknown>;
  groupId: string | undefined;
  dedupId: string | undefined;
}

/**
 * Lê e apaga tudo o que está na fila, na ordem de entrega, até `emptyRounds` receives
 * vazios seguidos.
 */
export async function drain(sqs: SQSClient, url: string, emptyRounds = 3): Promise<ReceivedEvent[]> {
  const received: ReceivedEvent[] = [];
  let empty = 0;
  while (empty < emptyRounds) {
    const { Messages = [] } = await sqs.send(
      new ReceiveMessageCommand({
        QueueUrl: url,
        MaxNumberOfMessages: 10,
        WaitTimeSeconds: 0,
        VisibilityTimeout: 300,
        MessageSystemAttributeNames: ['MessageGroupId', 'MessageDeduplicationId'],
      }),
    );
    if (Messages.length === 0) {
      empty++;
      continue;
    }
    empty = 0;
    for (const message of Messages) {
      received.push({
        body: JSON.parse(message.Body ?? '{}') as Record<string, unknown>,
        groupId: message.Attributes?.MessageGroupId,
        dedupId: message.Attributes?.MessageDeduplicationId,
      });
    }
    await sqs.send(
      new DeleteMessageBatchCommand({
        QueueUrl: url,
        Entries: Messages.map((message, index) => ({ Id: String(index), ReceiptHandle: message.ReceiptHandle })),
      }),
    );
  }
  return received;
}

export interface SyntheticEvent {
  id: string;
  aggregateId: string;
  /** Posição do evento no agregado (1, 2, …), também gravada no payload. */
  position: number;
}

/** Insere eventos pendentes direto na outbox, na ordem dada (seq crescente por agregado). */
export async function insertEvents(
  orm: MikroORM,
  aggregates: readonly string[],
  perAggregate: number,
  occurredAt = new Date(),
): Promise<SyntheticEvent[]> {
  const events: SyntheticEvent[] = [];
  for (let position = 1; position <= perAggregate; position++) {
    for (const aggregateId of aggregates) events.push({ id: randomUUID(), aggregateId, position });
  }
  const rows = events.map((event) => ({
    id: event.id,
    aggregate_id: event.aggregateId,
    event_type: 'WalletBalanceChanged',
    payload: JSON.stringify({
      eventId: event.id,
      eventType: 'WalletBalanceChanged',
      aggregateId: event.aggregateId,
      correlationId: 'corr-test',
      occurredAt: occurredAt.toISOString(),
      version: 1,
      data: { position: event.position },
    }),
    occurred_at: occurredAt,
    attempts: 0,
  }));
  // Um INSERT por lote, na ordem: seq segue a ordem das linhas.
  for (let i = 0; i < rows.length; i += 500) {
    await orm.em.getKnex().insert(rows.slice(i, i + 500)).into('outbox_messages');
  }
  return events;
}

export interface OutboxRowState {
  id: string;
  aggregate_id: string;
  seq: string;
  attempts: number;
  next_attempt_at: Date | null;
  published_at: Date | null;
  payload: Record<string, unknown>;
}

export async function outboxRows(orm: MikroORM): Promise<OutboxRowState[]> {
  // execute() devolve timestamptz como string.
  const rows = await orm.em
    .fork()
    .execute<Array<Omit<OutboxRowState, "next_attempt_at" | "published_at"> & { next_attempt_at: string | null; published_at: string | null }>>(
      'select id, aggregate_id, seq, attempts, next_attempt_at, published_at, payload from outbox_messages order by seq',
    );
  const date = (value: string | null) => (value === null ? null : new Date(value));
  return rows.map((row) => ({ ...row, next_attempt_at: date(row.next_attempt_at), published_at: date(row.published_at) }));
}

export async function pendingCount(orm: MikroORM): Promise<number> {
  const [row] = await orm.em
    .fork()
    .execute<Array<{ n: string }>>('select count(*)::text as n from outbox_messages where published_at is null');
  return Number(row?.n ?? 0);
}

/** Relógio manual: o teste avança o tempo e confere o backoff pelos valores gravados. */
export class ManualClock implements Clock {
  constructor(private current: Date) {}
  now(): Date {
    return new Date(this.current);
  }
  advance(ms: number): void {
    this.current = new Date(this.current.getTime() + ms);
  }
}

export const TEST_PUBLISHER_OPTIONS: OutboxPublisherOptions = {
  batchSize: 10,
  pollIntervalMs: 50,
  sqsTimeoutMs: 2_000,
  stuckAttempts: 10,
  shutdownTimeoutMs: 5_000,
};

type Events = Pick<OutboxEventsClient, 'publish'>;

export interface PublisherFixture {
  publisher: OutboxPublisher;
  store: OutboxStore;
  events: Events;
  metrics: ObservabilityMetrics;
}

export function buildPublisher(
  orm: MikroORM,
  sqs: SQSClient,
  queueName: string,
  overrides: {
    clock?: Clock;
    options?: Partial<OutboxPublisherOptions>;
    store?: OutboxStore;
    wrapEvents?: (real: OutboxEventsClient) => Events;
    logger?: Logger;
  } = {},
): PublisherFixture {
  const store = overrides.store ?? new OutboxStore(orm.em, 15_000);
  const real = new OutboxEventsClient(sqs, queueName);
  const events = overrides.wrapEvents ? overrides.wrapEvents(real) : real;
  const metrics = new ObservabilityMetrics();
  const publisher = new OutboxPublisher(
    store,
    events,
    overrides.clock ?? systemClock,
    metrics,
    { ...TEST_PUBLISHER_OPTIONS, ...overrides.options },
    overrides.logger,
  );
  return { publisher, store, events, metrics };
}

/** Embrulha o cliente real registrando cada envio (eventIds, na ordem) e permitindo falhas injetadas. */
export class SpyEvents implements Events {
  /** Um item por chamada: os eventIds enviados. */
  readonly calls: string[][] = [];
  /** eventIds aceitos pelo broker, na ordem em que voltaram. */
  readonly published: string[] = [];

  constructor(
    private readonly real: Events,
    private readonly fault: (messages: readonly OutboxMessage[]) => 'throw' | ReadonlySet<string> | undefined = () =>
      undefined,
  ) {}

  async publish(messages: readonly OutboxMessage[], signal: AbortSignal): Promise<PublishResult> {
    this.calls.push(messages.map((message) => message.id));
    const fault = this.fault(messages);
    if (fault === 'throw') throw new Error('SQS indisponível (injetado)');
    const rejected = fault ?? new Set<string>();
    const accepted = messages.filter((message) => !rejected.has(message.id));
    const result = accepted.length > 0 ? await this.real.publish(accepted, signal) : { published: new Set<string>(), failed: new Map<string, string>() };
    const failed = new Map(result.failed);
    for (const id of rejected) failed.set(id, 'InjectedFailure');
    this.published.push(...accepted.map((message) => message.id).filter((id) => result.published.has(id)));
    return { published: result.published, failed };
  }
}

export async function eventually(check: () => Promise<void> | void, timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      await check();
      return;
    } catch (error) {
      if (Date.now() > deadline) throw error;
      await Bun.sleep(50);
    }
  }
}

/** Logger pino que guarda cada linha (já parseada) para o teste conferir. */
export function captureLogger(): { logger: Logger; lines: Array<Record<string, unknown>> } {
  const lines: Array<Record<string, unknown>> = [];
  const logger = pino({ level: 'info' }, { write: (line: string) => lines.push(JSON.parse(line) as Record<string, unknown>) });
  return { logger, lines };
}

/**
 * Põe no payload um caractere que o SQS recusa (U+FFFF). O LocalStack devolve, para essa
 * entrada, um `Failed` real (`InvalidMessageContents`) e aceita as outras do lote.
 */
export async function poison(orm: MikroORM, eventId: string): Promise<void> {
  await orm.em
    .fork()
    .execute(`update outbox_messages set payload = jsonb_set(payload, '{data,poison}', to_jsonb(?::text)) where id = ?`, [
      '￿',
      eventId,
    ]);
}

/** Encerra (como uma morte do processo) a sessão do publisher que segura o lock do claim. */
export async function killClaimSession(orm: MikroORM): Promise<number> {
  const rows = await orm.em.fork().execute<Array<{ killed: boolean }>>(
    `select pg_terminate_backend(pid, 5000) as killed from pg_stat_activity
     where datname = current_database() and pid <> pg_backend_pid()
       and state = 'idle in transaction' and query ilike '%from outbox_messages%skip locked%'`,
  );
  return rows.filter((row) => row.killed).length;
}

/** Tenta travar o evento sem esperar: true quando ninguém mais segura o lock. */
export async function canLock(orm: MikroORM, eventId: string): Promise<boolean> {
  try {
    await orm.em.fork().transactional(async (em) => {
      await em.execute('select id from outbox_messages where id = ? for update nowait', [eventId]);
    });
    return true;
  } catch {
    return false;
  }
}

/** Promessa controlada pelo teste. */
export function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => (resolve = r));
  return { promise, resolve };
}
