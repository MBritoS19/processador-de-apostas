import 'reflect-metadata';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import type { INestApplication } from '@nestjs/common';
import type { MikroORM } from '@mikro-orm/postgresql';
import { loadConfig } from '../../../src/infrastructure/config/app-config';
import { createSqsClient } from '../../../src/infrastructure/messaging/sqs.client';
import { ObservabilityMetrics } from '../../../src/infrastructure/observability/metrics';
import { countRows } from '../application/harness';
import { expectLedgerConsistent, openOrm, seedWallet, truncateAll } from '../persistence/db';
import {
  FailingDeleteQueueClient,
  createQueues,
  deleteQueues,
  envelope,
  eventually,
  failing,
  gated,
  queueDepth,
  readDlq,
  send,
  startConsumerApp,
  visibleCount,
  type ConsumerAppOptions,
  type TestQueues,
} from './sqs-harness';

/** Consumidor SQS de ponta a ponta: LocalStack e Postgres reais, aplicação Nest inteira. */
describe('consumidor SQS (LocalStack + Postgres reais)', () => {
  const sqs = createSqsClient(loadConfig());
  let orm: MikroORM;
  let queues: TestQueues;
  const apps: INestApplication[] = [];

  beforeAll(async () => {
    orm = await openOrm();
  });

  beforeEach(async () => {
    await truncateAll(orm);
    queues = await createQueues(sqs);
  });

  afterEach(async () => {
    await Promise.all(apps.splice(0).map((app) => app.close()));
    await deleteQueues(sqs, queues);
  });

  afterAll(async () => {
    await orm.close();
    sqs.destroy();
  });

  async function start(options: Omit<ConsumerAppOptions, 'queues'> = {}): Promise<INestApplication> {
    const app = await startConsumerApp({ queues, ...options });
    apps.push(app);
    return app;
  }

  async function stop(app: INestApplication): Promise<void> {
    apps.splice(apps.indexOf(app), 1);
    await app.close();
  }

  const counter = async (app: INestApplication, name: 'retries' | 'dlqMessages' | 'replays') =>
    (await app.get(ObservabilityMetrics)[name].get()).values.reduce((sum, value) => sum + value.value, 0);

  const debits = (walletId: string) => countRows(orm, 'wallet_ledger_entries', { wallet_id: walletId, direction: 'DEBIT' });
  const balance = async (walletId: string) =>
    (await orm.em.getKnex()('wallets').where({ id: walletId }).first('balance')).balance as string;

  async function expectDrained(): Promise<void> {
    await eventually(async () => expect(await queueDepth(sqs, queues.queueUrl)).toBe(0));
  }

  it('mensagem válida: efeito aplicado, inbox gravada, fila vazia', async () => {
    const wallet = await seedWallet(orm, '100.00');
    await start();
    const message = envelope(wallet, { correlationId: 'corr-sqs-1' });
    await send(sqs, queues.queueUrl, message);

    await eventually(async () => expect(await debits(wallet.walletId)).toBe(1));
    await expectDrained();
    expect(await balance(wallet.walletId)).toBe('90.00');
    expect(await countRows(orm, 'inbox_messages', { consumer_name: 'wager-consumer-test', message_id: message.messageId })).toBe(1);
    expect(await countRows(orm, 'outbox_messages')).toBe(2);
    const outbox = await orm.em.getKnex()('outbox_messages').select('payload');
    expect(outbox.every((row) => row.payload.correlationId === 'corr-sqs-1')).toBe(true);
    expect(outbox.every((row) => row.payload.causationId !== undefined)).toBe(true);
    expect(await readDlq(sqs, queues.dlqUrl)).toEqual([]);
    await expectLedgerConsistent(orm, wallet.walletId);
  });

  it('a mesma mensagem entregue duas vezes: um único efeito', async () => {
    const wallet = await seedWallet(orm, '100.00');
    const message = envelope(wallet);
    // Dedup ids diferentes: o broker não descarta, a inbox precisa resolver.
    await send(sqs, queues.queueUrl, message, { dedupId: 'copy-1' });
    await send(sqs, queues.queueUrl, message, { dedupId: 'copy-2' });
    const app = await start();

    await expectDrained();
    expect(await debits(wallet.walletId)).toBe(1);
    expect(await countRows(orm, 'wager_transactions', { wallet_id: wallet.walletId, kind: 'BET' })).toBe(1);
    expect(await countRows(orm, 'inbox_messages')).toBe(1);
    expect(await counter(app, 'replays')).toBe(1);
    expect(await balance(wallet.walletId)).toBe('90.00');
    expect(await readDlq(sqs, queues.dlqUrl)).toEqual([]);
    await expectLedgerConsistent(orm, wallet.walletId);
  });

  it('outro messageId com a mesma idempotencyKey: replay pelo use case, um único efeito', async () => {
    const wallet = await seedWallet(orm, '100.00');
    const first = envelope(wallet);
    const second = { ...first, messageId: 'msg-reenviada-pelo-provedor' };
    await send(sqs, queues.queueUrl, first);
    await send(sqs, queues.queueUrl, second);
    const app = await start();

    await expectDrained();
    expect(await debits(wallet.walletId)).toBe(1);
    expect(await countRows(orm, 'inbox_messages')).toBe(2);
    expect(await counter(app, 'replays')).toBe(1);
    expect(await readDlq(sqs, queues.dlqUrl)).toEqual([]);
    await expectLedgerConsistent(orm, wallet.walletId);
  });

  it('rejeição de negócio: ack, transação REJECTED, nada na DLQ', async () => {
    const wallet = await seedWallet(orm, '100.00');
    await start();
    await send(sqs, queues.queueUrl, envelope(wallet, { data: { money: { amount: '500.00', currency: 'BRL' } } }));

    await eventually(async () =>
      expect(await countRows(orm, 'wager_transactions', { status: 'REJECTED', failure_code: 'INSUFFICIENT_BALANCE' })).toBe(1),
    );
    await expectDrained();
    expect(await debits(wallet.walletId)).toBe(0);
    expect(await countRows(orm, 'inbox_messages')).toBe(1);
    expect(await readDlq(sqs, queues.dlqUrl)).toEqual([]);
    await expectLedgerConsistent(orm, wallet.walletId);
  });

  it('IdempotencyConflict (mesma key, outro payload, outro messageId): ack, sem DLQ', async () => {
    const wallet = await seedWallet(orm, '100.00');
    const first = envelope(wallet);
    const data = first.data as Record<string, unknown>;
    const conflicting = envelope(wallet, { data: { ...data, money: { amount: '20.00', currency: 'BRL' } } });
    await send(sqs, queues.queueUrl, first);
    await send(sqs, queues.queueUrl, conflicting);
    await start();

    await expectDrained();
    expect(await debits(wallet.walletId)).toBe(1);
    expect(await balance(wallet.walletId)).toBe('90.00');
    expect(await readDlq(sqs, queues.dlqUrl)).toEqual([]);
    await expectLedgerConsistent(orm, wallet.walletId);
  });

  it.each([
    ['corpo não-JSON', () => '{nope', 'INVALID_ENVELOPE', 'corpo não é JSON'],
    ['type errado', (w: Wallet) => envelope(w, { type: 'Outro' }), 'INVALID_ENVELOPE', 'type deve ser WagerTransactionRequested'],
    ['sem idempotencyKey', (w: Wallet) => envelope(w, { data: { idempotencyKey: undefined } }), 'INVALID_ENVELOPE', 'data.idempotencyKey é obrigatório'],
    ['kind OPENING', (w: Wallet) => envelope(w, { data: { kind: 'OPENING' } }), 'INVALID_PAYLOAD', 'kind deve ser BET, WIN, LOSS, REFUND ou ROLLBACK'],
    ['providerId internal', (w: Wallet) => envelope(w, { data: { providerId: 'internal' } }), 'INVALID_PAYLOAD', 'providerId "internal" é reservado'],
  ] as const)('%s: DLQ com o motivo, sem efeito', async (_, build, reason, detail) => {
    const wallet = await seedWallet(orm, '100.00');
    const app = await start();
    await send(sqs, queues.queueUrl, build(wallet), { groupId: wallet.walletId });

    let dead: Awaited<ReturnType<typeof readDlq>> = [];
    await eventually(async () => {
      dead = await readDlq(sqs, queues.dlqUrl);
      expect(dead).toHaveLength(1);
    });
    expect(dead[0]?.reason).toBe(reason);
    expect(dead[0]?.detail).toBe(detail);
    await expectDrained();
    expect(await counter(app, 'dlqMessages')).toBe(1);
    expect(await countRows(orm, 'wager_transactions', { wallet_id: wallet.walletId, kind: 'BET' })).toBe(0);
    expect(await countRows(orm, 'inbox_messages')).toBe(0);
    await expectLedgerConsistent(orm, wallet.walletId);
  });

  it('mesmo messageId com payload diferente: DLQ INBOX_PAYLOAD_MISMATCH, sem efeito novo', async () => {
    const wallet = await seedWallet(orm, '100.00');
    const original = envelope(wallet);
    const tampered = envelope(wallet, { messageId: original.messageId as string });
    await send(sqs, queues.queueUrl, original);
    await send(sqs, queues.queueUrl, tampered, { dedupId: 'tampered' });
    await start();

    await eventually(async () => expect((await readDlq(sqs, queues.dlqUrl))[0]?.reason).toBe('INBOX_PAYLOAD_MISMATCH'));
    await expectDrained();
    expect(await debits(wallet.walletId)).toBe(1);
    await expectLedgerConsistent(orm, wallet.walletId);
  });

  it('falha transitória: retry com backoff e depois sucesso, um único efeito', async () => {
    const wallet = await seedWallet(orm, '100.00');
    const flaky = failing(2);
    const app = await start({ wrapProcess: flaky.wrap, consumer: { retryBaseSeconds: 1, retryMaxSeconds: 1 } });
    await send(sqs, queues.queueUrl, envelope(wallet));

    await eventually(async () => expect(await debits(wallet.walletId)).toBe(1), 20_000);
    await expectDrained();
    expect(flaky.calls()).toBe(3);
    expect(await counter(app, 'retries')).toBe(2);
    expect(await readDlq(sqs, queues.dlqUrl)).toEqual([]);
    await expectLedgerConsistent(orm, wallet.walletId);
  });

  it('erro inesperado (exceção) é tratado como transitório: retry e depois sucesso', async () => {
    const wallet = await seedWallet(orm, '100.00');
    const flaky = failing(1, 'throw');
    const app = await start({ wrapProcess: flaky.wrap });
    await send(sqs, queues.queueUrl, envelope(wallet));

    await eventually(async () => expect(await debits(wallet.walletId)).toBe(1));
    await expectDrained();
    expect(await counter(app, 'retries')).toBe(1);
    await expectLedgerConsistent(orm, wallet.walletId);
  });

  it('falha transitória além do limite (maxReceiveCount=5): DLQ MAX_ATTEMPTS_EXCEEDED', async () => {
    const wallet = await seedWallet(orm, '100.00');
    const flaky = failing(Number.POSITIVE_INFINITY);
    const app = await start({ wrapProcess: flaky.wrap });
    await send(sqs, queues.queueUrl, envelope(wallet));

    await eventually(async () => {
      const dead = await readDlq(sqs, queues.dlqUrl);
      expect(dead.map((d) => [d.reason, d.detail])).toEqual([['MAX_ATTEMPTS_EXCEEDED', 'lock_timeout']]);
    }, 20_000);
    await expectDrained();
    expect(flaky.calls()).toBe(5);
    expect(await counter(app, 'retries')).toBe(4);
    expect(await counter(app, 'dlqMessages')).toBe(1);
    expect(await debits(wallet.walletId)).toBe(0);
    await expectLedgerConsistent(orm, wallet.walletId);
  });

  it('worker morto depois do commit e antes do ack: reentrega, inbox detecta, um único efeito', async () => {
    const wallet = await seedWallet(orm, '100.00');
    let client: FailingDeleteQueueClient | undefined;
    const app = await start({
      consumer: { visibilityTimeoutSeconds: 2 },
      queueClient: (sqsClient, config) => (client = new FailingDeleteQueueClient(sqsClient, config, 1)),
    });
    await send(sqs, queues.queueUrl, envelope(wallet));

    await eventually(async () => expect(client?.deletes).toBe(2), 20_000);
    await expectDrained();
    expect(await debits(wallet.walletId)).toBe(1);
    expect(await countRows(orm, 'inbox_messages')).toBe(1);
    expect(await counter(app, 'replays')).toBe(1);
    expect(await balance(wallet.walletId)).toBe('90.00');
    await expectLedgerConsistent(orm, wallet.walletId);
  });

  it('duas instâncias com a mesma mensagem em paralelo: um efeito, as duas confirmam, nada na DLQ', async () => {
    const wallet = await seedWallet(orm, '100.00');
    const gate = gated();
    await start({ wrapProcess: gate.wrap, consumer: { maxMessages: 1 } });
    await start({ wrapProcess: gate.wrap, consumer: { maxMessages: 1 } });
    const message = envelope(wallet);
    // Grupos distintos: as duas cópias podem estar em voo ao mesmo tempo (uma em cada instância).
    await send(sqs, queues.queueUrl, message, { groupId: 'copy-a', dedupId: 'copy-a' });
    await send(sqs, queues.queueUrl, message, { groupId: 'copy-b', dedupId: 'copy-b' });

    await eventually(() => expect(gate.calls()).toBe(2));
    gate.open();
    await expectDrained();
    expect(await debits(wallet.walletId)).toBe(1);
    expect(await countRows(orm, 'inbox_messages')).toBe(1);
    expect(await readDlq(sqs, queues.dlqUrl)).toEqual([]);
    await expectLedgerConsistent(orm, wallet.walletId);
  });

  it('duas instâncias, mesmo messageId com payloads diferentes em paralelo: um efeito, a outra na DLQ', async () => {
    const wallet = await seedWallet(orm, '100.00');
    const gate = gated();
    await start({ wrapProcess: gate.wrap, consumer: { maxMessages: 1 } });
    await start({ wrapProcess: gate.wrap, consumer: { maxMessages: 1 } });
    const first = envelope(wallet);
    const second = envelope(wallet, { messageId: first.messageId as string });
    await send(sqs, queues.queueUrl, first, { groupId: 'copy-a', dedupId: 'copy-a' });
    await send(sqs, queues.queueUrl, second, { groupId: 'copy-b', dedupId: 'copy-b' });

    await eventually(() => expect(gate.calls()).toBe(2));
    gate.open();
    await eventually(async () =>
      expect((await readDlq(sqs, queues.dlqUrl)).map((d) => d.reason)).toEqual(['INBOX_PAYLOAD_MISMATCH']),
    );
    await expectDrained();
    expect(await debits(wallet.walletId)).toBe(1);
    expect(await countRows(orm, 'wager_transactions', { wallet_id: wallet.walletId, kind: 'BET' })).toBe(1);
    await expectLedgerConsistent(orm, wallet.walletId);
  });

  it('mensagens do mesmo grupo em sequência, grupos diferentes em paralelo', async () => {
    const a = await seedWallet(orm, '100.00');
    const b = await seedWallet(orm, '100.00');
    await start();
    for (let i = 0; i < 5; i++) {
      await send(sqs, queues.queueUrl, envelope(a));
      await send(sqs, queues.queueUrl, envelope(b));
    }

    await expectDrained();
    expect(await debits(a.walletId)).toBe(5);
    expect(await debits(b.walletId)).toBe(5);
    expect(await balance(a.walletId)).toBe('50.00');
    expect(await balance(b.walletId)).toBe('50.00');
    await expectLedgerConsistent(orm, a.walletId);
    await expectLedgerConsistent(orm, b.walletId);
  });

  it('SIGTERM com mensagem em andamento dentro do prazo: termina e confirma', async () => {
    const wallet = await seedWallet(orm, '100.00');
    const gate = gated();
    const app = await start({ wrapProcess: gate.wrap, consumer: { shutdownTimeoutMs: 10_000 } });
    await send(sqs, queues.queueUrl, envelope(wallet));
    await gate.started;

    const closing = stop(app);
    await Bun.sleep(300);
    gate.open();
    await closing;

    expect(await debits(wallet.walletId)).toBe(1);
    expect(await queueDepth(sqs, queues.queueUrl)).toBe(0);
    await expectLedgerConsistent(orm, wallet.walletId);
  });

  it('SIGTERM com mensagem em andamento além do prazo: devolve a visibilidade, outra instância processa uma vez', async () => {
    const wallet = await seedWallet(orm, '100.00');
    const gate = gated();
    const app = await start({ wrapProcess: gate.wrap, consumer: { shutdownTimeoutMs: 200, visibilityTimeoutSeconds: 30 } });
    await send(sqs, queues.queueUrl, envelope(wallet));
    await gate.started;

    await stop(app);
    // Visível de novo bem antes dos 30s de visibilidade: foi devolvida no shutdown.
    await eventually(async () => expect(await visibleCount(sqs, queues.queueUrl)).toBe(1), 5_000);
    gate.abort();

    await start();
    await expectDrained();
    expect(await debits(wallet.walletId)).toBe(1);
    expect(await countRows(orm, 'inbox_messages')).toBe(1);
    await expectLedgerConsistent(orm, wallet.walletId);
  });
});

type Wallet = { walletId: string; playerId: string };
