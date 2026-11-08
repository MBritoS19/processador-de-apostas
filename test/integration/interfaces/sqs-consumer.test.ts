import 'reflect-metadata';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import type { INestApplication } from '@nestjs/common';
import type { MikroORM } from '@mikro-orm/postgresql';
import { randomUUID } from 'node:crypto';
import type { ProcessWagerTransactionCommand } from '../../../src/application/wagering/process-wager-transaction';
import { loadConfig, type AppConfig } from '../../../src/infrastructure/config/app-config';
import { createSqsClient } from '../../../src/infrastructure/messaging/sqs.client';
import { ObservabilityMetrics } from '../../../src/infrastructure/observability/metrics';
import { WagerConsumer } from '../../../src/interfaces/sqs/wager-consumer';
import { countRows } from '../application/harness';
import { expectLedgerConsistent, openOrm, seedWallet, truncateAll } from '../persistence/db';
import {
  SpyQueueClient,
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
  type QueueFaults,
  type TestQueues,
} from './sqs-harness';

type Wallet = { walletId: string; playerId: string };

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

  /** Cliente espião: `spy.client` fica disponível depois que a aplicação sobe. */
  function spyQueue(faults: QueueFaults = {}) {
    const spy: { client?: SpyQueueClient; factory: (s: typeof sqs, config: AppConfig) => SpyQueueClient } = {
      factory: (sqsClient, config) => (spy.client = new SpyQueueClient(sqsClient, config, faults)),
    };
    return spy;
  }

  const counter = async (list: INestApplication[], name: 'retries' | 'dlqMessages' | 'replays') => {
    let total = 0;
    for (const app of list) {
      total += (await app.get(ObservabilityMetrics)[name].get()).values.reduce((sum, value) => sum + value.value, 0);
    }
    return total;
  };

  const debits = (walletId: string) => countRows(orm, 'wallet_ledger_entries', { wallet_id: walletId, direction: 'DEBIT' });
  const balance = async (walletId: string) =>
    (await orm.em.getKnex()('wallets').where({ id: walletId }).first('balance')).balance as string;
  const statusOf = async (externalTransactionId: string) =>
    (await orm.em.getKnex()('wager_transactions').where({ external_transaction_id: externalTransactionId }).first('status'))?.status as
      | string
      | undefined;

  async function expectDrained(timeoutMs?: number): Promise<void> {
    await eventually(async () => expect(await queueDepth(sqs, queues.queueUrl)).toBe(0), timeoutMs);
  }

  /** BET e, em seguida no mesmo grupo, o ROLLBACK dela. Fora de ordem, o ROLLBACK vira PENDING_REFERENCE. */
  async function sendBetThenRollback(wallet: Wallet): Promise<{ bet: string; rollback: string }> {
    const bet = `bet-${randomUUID()}`;
    const rollback = `rb-${randomUUID()}`;
    await send(sqs, queues.queueUrl, envelope(wallet, { data: { externalTransactionId: bet, idempotencyKey: `provider-a:${bet}` } }));
    await send(
      sqs,
      queues.queueUrl,
      envelope(wallet, {
        data: { externalTransactionId: rollback, idempotencyKey: `provider-a:${rollback}`, kind: 'ROLLBACK', referenceExternalTransactionId: bet },
      }),
    );
    return { bet, rollback };
  }

  const isExternal = (id: string) => (command: ProcessWagerTransactionCommand) => command.payload.externalTransactionId === id;

  it('mensagem válida: efeito aplicado, inbox gravada, fila vazia, causation = messageId', async () => {
    const wallet = await seedWallet(orm, '100.00');
    await start();
    const message = envelope(wallet, { correlationId: 'corr-sqs-1' });
    await send(sqs, queues.queueUrl, message);

    await eventually(async () => expect(await debits(wallet.walletId)).toBe(1));
    await expectDrained();
    expect(await balance(wallet.walletId)).toBe('90.00');
    expect(await countRows(orm, 'inbox_messages', { consumer_name: 'wager-consumer-test', message_id: message.messageId })).toBe(1);
    const outbox = await orm.em.getKnex()('outbox_messages').select('event_type', 'payload');
    expect(outbox).toHaveLength(2);
    expect(outbox.every((row) => row.payload.correlationId === 'corr-sqs-1')).toBe(true);
    const processed = outbox.find((row) => row.event_type === 'WagerTransactionProcessed');
    const changed = outbox.find((row) => row.event_type === 'WalletBalanceChanged');
    expect(processed?.payload.causationId).toBe(message.messageId);
    expect(changed?.payload.causationId).toBe(processed?.payload.eventId);
    expect(await readDlq(sqs, queues.dlqUrl)).toEqual([]);
    await expectLedgerConsistent(orm, wallet.walletId);
  });

  it('a mesma mensagem entregue duas vezes: a inbox confirma a 2ª sem chamar o use case', async () => {
    const wallet = await seedWallet(orm, '100.00');
    const message = envelope(wallet);
    // Dedup ids diferentes: o broker não descarta, a inbox precisa resolver.
    await send(sqs, queues.queueUrl, message, { dedupId: 'copy-1' });
    await send(sqs, queues.queueUrl, message, { dedupId: 'copy-2' });
    const counting = failing(0);
    const app = await start({ wrapProcess: counting.wrap });

    await expectDrained();
    expect(counting.calls()).toBe(1);
    expect(await debits(wallet.walletId)).toBe(1);
    expect(await countRows(orm, 'wager_transactions', { wallet_id: wallet.walletId, kind: 'BET' })).toBe(1);
    expect(await countRows(orm, 'inbox_messages')).toBe(1);
    expect(await counter([app], 'replays')).toBe(1);
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
    const counting = failing(0);
    const app = await start({ wrapProcess: counting.wrap });

    await expectDrained();
    expect(counting.calls()).toBe(2);
    expect(await debits(wallet.walletId)).toBe(1);
    expect(await countRows(orm, 'inbox_messages')).toBe(2);
    expect(await counter([app], 'replays')).toBe(1);
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
    expect(await counter([app], 'dlqMessages')).toBe(1);
    expect(await countRows(orm, 'wager_transactions', { wallet_id: wallet.walletId, kind: 'BET' })).toBe(0);
    expect(await countRows(orm, 'inbox_messages')).toBe(0);
    await expectLedgerConsistent(orm, wallet.walletId);
  });

  it('envelope que estoura o parser (aninhamento profundo): DLQ INVALID_ENVELOPE, não loop', async () => {
    const depth = 60_000;
    const body = `{"messageId":"m-deep","type":"WagerTransactionRequested","occurredAt":"2026-11-07T12:00:00Z","data":{"idempotencyKey":"k","x":${'['.repeat(depth)}${']'.repeat(depth)}}}`;
    await start();
    await send(sqs, queues.queueUrl, body, { groupId: 'deep' });

    await eventually(async () => expect((await readDlq(sqs, queues.dlqUrl)).map((d) => d.reason)).toEqual(['INVALID_ENVELOPE']));
    await expectDrained();
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

  it('falha transitória: visibilidade 30/60/120/240 por ApproximateReceiveCount e sucesso na 5ª, um único efeito', async () => {
    const wallet = await seedWallet(orm, '100.00');
    const flaky = failing(4);
    const spy = spyQueue({ fakeVisibility: true });
    const app = await start({
      wrapProcess: flaky.wrap,
      queueClient: spy.factory,
      consumer: { retryBaseSeconds: 30, retryMaxSeconds: 300 },
    });
    await send(sqs, queues.queueUrl, envelope(wallet));

    await eventually(async () => expect(await debits(wallet.walletId)).toBe(1));
    await expectDrained();
    expect(spy.client?.visibilities).toEqual([30, 60, 120, 240]);
    expect(flaky.calls()).toBe(5);
    expect(await counter([app], 'retries')).toBe(4);
    expect(await readDlq(sqs, queues.dlqUrl)).toEqual([]);
    await expectLedgerConsistent(orm, wallet.walletId);
  });

  it('erro inesperado (exceção) é tratado como transitório: retry e depois sucesso', async () => {
    const wallet = await seedWallet(orm, '100.00');
    const flaky = failing(1, { mode: 'throw' });
    const app = await start({ wrapProcess: flaky.wrap });
    await send(sqs, queues.queueUrl, envelope(wallet));

    await eventually(async () => expect(await debits(wallet.walletId)).toBe(1));
    await expectDrained();
    expect(await counter([app], 'retries')).toBe(1);
    await expectLedgerConsistent(orm, wallet.walletId);
  });

  it('falha transitória além do limite do consumidor (5, fila em 10): DLQ MAX_ATTEMPTS_EXCEEDED', async () => {
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
    expect(await counter([app], 'retries')).toBe(4);
    expect(await counter([app], 'dlqMessages')).toBe(1);
    expect(await debits(wallet.walletId)).toBe(0);
    await expectLedgerConsistent(orm, wallet.walletId);
  });

  it('retry no meio do grupo: a mensagem seguinte espera (ROLLBACK só depois da BET)', async () => {
    const wallet = await seedWallet(orm, '100.00');
    const betExternal = { id: '' };
    const flaky = failing(1, { when: (command) => isExternal(betExternal.id)(command) });
    const sent = await sendBetThenRollback(wallet);
    betExternal.id = sent.bet;
    // Backoff real de 1s: o ROLLBACK não pode ficar visível antes da BET.
    const app = await start({ wrapProcess: flaky.wrap, consumer: { retryBaseSeconds: 1, retryMaxSeconds: 1 } });

    await expectDrained();
    expect(await counter([app], 'retries')).toBe(1);
    expect(await statusOf(sent.bet)).toBe('PROCESSED');
    expect(await statusOf(sent.rollback)).toBe('PROCESSED');
    expect(await balance(wallet.walletId)).toBe('100.00');
    await expectLedgerConsistent(orm, wallet.walletId);
  });

  it('ação no SQS falhou (ChangeMessageVisibility): o grupo para e a ordem se mantém', async () => {
    const wallet = await seedWallet(orm, '100.00');
    const betExternal = { id: '' };
    const flaky = failing(1, { when: (command) => isExternal(betExternal.id)(command) });
    const sent = await sendBetThenRollback(wallet);
    betExternal.id = sent.bet;
    const spy = spyQueue({ failVisibilityChanges: 1 });
    await start({ wrapProcess: flaky.wrap, queueClient: spy.factory, consumer: { visibilityTimeoutSeconds: 2 } });

    await expectDrained(20_000);
    expect(await statusOf(sent.bet)).toBe('PROCESSED');
    expect(await statusOf(sent.rollback)).toBe('PROCESSED');
    expect(await balance(wallet.walletId)).toBe('100.00');
    await expectLedgerConsistent(orm, wallet.walletId);
  });

  it('a primeira do grupo esgota as tentativas: vai para a DLQ e as seguintes são processadas', async () => {
    const wallet = await seedWallet(orm, '100.00');
    const head = envelope(wallet);
    const follower = envelope(wallet, { data: { money: { amount: '20.00', currency: 'BRL' } } });
    const headExternal = (head.data as { externalTransactionId: string }).externalTransactionId;
    await send(sqs, queues.queueUrl, head);
    await send(sqs, queues.queueUrl, follower);
    const flaky = failing(Number.POSITIVE_INFINITY, { when: isExternal(headExternal) });
    await start({ wrapProcess: flaky.wrap });

    await expectDrained(20_000);
    expect((await readDlq(sqs, queues.dlqUrl)).map((d) => d.reason)).toEqual(['MAX_ATTEMPTS_EXCEEDED']);
    // 5 tentativas da primeira + 1 da seguinte: a seguinte nunca passou à frente.
    expect(flaky.calls()).toBe(6);
    expect(await debits(wallet.walletId)).toBe(1);
    expect(await balance(wallet.walletId)).toBe('80.00');
    await expectLedgerConsistent(orm, wallet.walletId);
  });

  it('banco indisponível: o polling pausa antes de buscar de novo', async () => {
    const wallet = await seedWallet(orm, '100.00');
    const flaky = failing(1, { reason: 'unavailable' });
    const spy = spyQueue();
    await start({ wrapProcess: flaky.wrap, queueClient: spy.factory });
    await send(sqs, queues.queueUrl, envelope(wallet));

    await eventually(async () => expect(await debits(wallet.walletId)).toBe(1));
    await expectDrained();
    const receives = spy.client?.receives ?? [];
    const first = receives.findIndex((r) => r.count === 1);
    const failed = receives[first];
    const next = receives[first + 1];
    expect(failed?.endedAt).toBeDefined();
    // pollPauseMs(1) = 1s entre o lote com falha e o próximo ReceiveMessage.
    expect((next?.startedAt ?? 0) - (failed?.endedAt ?? 0)).toBeGreaterThanOrEqual(900);
    await expectLedgerConsistent(orm, wallet.walletId);
  });

  it('worker morto depois do commit e antes do ack: reentrega, inbox detecta sem chamar o use case', async () => {
    const wallet = await seedWallet(orm, '100.00');
    const spy = spyQueue({ failDeletes: 1 });
    const counting = failing(0);
    const app = await start({ wrapProcess: counting.wrap, queueClient: spy.factory, consumer: { visibilityTimeoutSeconds: 2 } });
    // `sqs_message_acked` só depois do DeleteMessage bem-sucedido; o delete que falhou loga só `sqs_ack_failed`.
    const logger = (app.get(WagerConsumer) as unknown as { logger: { info: (...a: unknown[]) => void; warn: (...a: unknown[]) => void } }).logger;
    const events: string[] = [];
    for (const level of ['info', 'warn'] as const) {
      const original = logger[level].bind(logger);
      logger[level] = (fields: unknown, ...rest: unknown[]) => {
        const { event, outcome } = (fields ?? {}) as { event?: string; outcome?: string };
        if (event === 'sqs_message_acked' || event === 'sqs_ack_failed') events.push(`${event}:${outcome}`);
        original(fields, ...rest);
      };
    }
    await send(sqs, queues.queueUrl, envelope(wallet));

    await eventually(async () => expect(spy.client?.deletes).toBe(2), 20_000);
    expect(events).toEqual(['sqs_ack_failed:PROCESSED', 'sqs_message_acked:DUPLICATE_MESSAGE']);
    await expectDrained();
    expect(counting.calls()).toBe(1);
    expect(await debits(wallet.walletId)).toBe(1);
    expect(await countRows(orm, 'inbox_messages')).toBe(1);
    expect(await counter([app], 'replays')).toBe(1);
    expect(await balance(wallet.walletId)).toBe('90.00');
    await expectLedgerConsistent(orm, wallet.walletId);
  });

  it('DeleteMessage falha depois do envio para a DLQ: reentrega não duplica na DLQ', async () => {
    const spy = spyQueue({ failDeletes: 1 });
    await start({ queueClient: spy.factory, consumer: { visibilityTimeoutSeconds: 2 } });
    await send(sqs, queues.queueUrl, '{nope', { groupId: 'bad' });

    await eventually(async () => expect(spy.client?.deletes).toBe(2), 20_000);
    await expectDrained();
    expect((await readDlq(sqs, queues.dlqUrl)).map((d) => d.reason)).toEqual(['INVALID_ENVELOPE']);
  });

  it('duas instâncias com a mesma mensagem em paralelo: um efeito, as duas confirmam, sem retry nem DLQ', async () => {
    const wallet = await seedWallet(orm, '100.00');
    const gate = gated();
    const both = [
      await start({ wrapProcess: gate.wrap, consumer: { maxMessages: 1 } }),
      await start({ wrapProcess: gate.wrap, consumer: { maxMessages: 1 } }),
    ];
    const message = envelope(wallet);
    // Grupos distintos: as duas cópias podem estar em voo ao mesmo tempo (uma em cada instância).
    await send(sqs, queues.queueUrl, message, { groupId: 'copy-a', dedupId: 'copy-a' });
    await send(sqs, queues.queueUrl, message, { groupId: 'copy-b', dedupId: 'copy-b' });

    await eventually(() => expect(gate.calls()).toBe(2));
    gate.open();
    await expectDrained();
    expect(await counter(both, 'retries')).toBe(0);
    expect(await debits(wallet.walletId)).toBe(1);
    expect(await countRows(orm, 'inbox_messages')).toBe(1);
    expect(await readDlq(sqs, queues.dlqUrl)).toEqual([]);
    await expectLedgerConsistent(orm, wallet.walletId);
  });

  it('duas instâncias, mesmo messageId com payloads diferentes em paralelo: um efeito, a outra na DLQ sem retry', async () => {
    const wallet = await seedWallet(orm, '100.00');
    const gate = gated();
    const both = [
      await start({ wrapProcess: gate.wrap, consumer: { maxMessages: 1 } }),
      await start({ wrapProcess: gate.wrap, consumer: { maxMessages: 1 } }),
    ];
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
    expect(await counter(both, 'retries')).toBe(0);
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

  it('SQS_CONSUMER_ENABLED=false: o consumidor não busca mensagens', async () => {
    const wallet = await seedWallet(orm, '100.00');
    const spy = spyQueue();
    await start({ queueClient: spy.factory, consumer: { enabled: false } });
    await send(sqs, queues.queueUrl, envelope(wallet));

    await Bun.sleep(1_500);
    expect(spy.client?.receives ?? []).toEqual([]);
    expect(await visibleCount(sqs, queues.queueUrl)).toBe(1);
    expect(await debits(wallet.walletId)).toBe(0);
  });

  it('SIGTERM durante o long polling (20s): o receive é abortado e o shutdown não espera o poll nem estoura o prazo', async () => {
    const wallet = await seedWallet(orm, '100.00');
    const spy = spyQueue();
    const app = await start({ queueClient: spy.factory, consumer: { waitTimeSeconds: 20, shutdownTimeoutMs: 15_000 } });
    // Um receive de 20s em andamento, fila vazia.
    await eventually(async () => expect(spy.client?.receives.length).toBeGreaterThan(0));
    const logger = (app.get(WagerConsumer) as unknown as { logger: { warn: (...a: unknown[]) => void; error: (...a: unknown[]) => void } }).logger;
    const events: string[] = [];
    for (const level of ['warn', 'error'] as const) {
      const original = logger[level].bind(logger);
      logger[level] = (fields: unknown, ...rest: unknown[]) => {
        events.push(String((fields as { event?: string } | undefined)?.event));
        original(fields, ...rest);
      };
    }

    const startedAt = Date.now();
    await stop(app);
    // Bem abaixo dos 20s do poll e dos 15s do prazo: o stop não esperou o long polling.
    expect(Date.now() - startedAt).toBeLessThan(5_000);
    expect(events, 'sem shutdown_timeout nem poll_failed').toEqual([]);
    // Mensagem enviada depois do stop: não é processada nem perdida. Abortar no cliente não cancela o
    // poll no servidor, que pode entregá-la à conexão abortada; aí ela fica em voo até a visibilidade
    // expirar e volta para outra instância (mesmo efeito de um processo que cai; ARCHITECTURE §18).
    await send(sqs, queues.queueUrl, envelope(wallet));
    expect(await queueDepth(sqs, queues.queueUrl)).toBe(1);
    expect(await debits(wallet.walletId)).toBe(0);
  });

  it('SIGTERM com mensagem em andamento dentro do prazo: termina, confirma e para de buscar', async () => {
    const wallet = await seedWallet(orm, '100.00');
    const gate = gated();
    const app = await start({ wrapProcess: gate.wrap, consumer: { shutdownTimeoutMs: 10_000 } });
    await send(sqs, queues.queueUrl, envelope(wallet));
    await gate.started;

    const closing = stop(app);
    // Chega durante o shutdown: não pode ser buscada.
    await send(sqs, queues.queueUrl, envelope(wallet), { groupId: 'late' });
    await Bun.sleep(300);
    gate.open();
    await closing;

    expect(await debits(wallet.walletId)).toBe(1);
    expect(gate.calls()).toBe(1);
    await eventually(async () => expect(await visibleCount(sqs, queues.queueUrl)).toBe(1));
    expect(await queueDepth(sqs, queues.queueUrl)).toBe(1);
    await expectLedgerConsistent(orm, wallet.walletId);
  });

  it('SIGTERM além do prazo: devolve a visibilidade; o processamento abandonado e outra instância geram um único efeito', async () => {
    const wallet = await seedWallet(orm, '100.00');
    const gate = gated();
    const app = await start({ wrapProcess: gate.wrap, consumer: { shutdownTimeoutMs: 200, visibilityTimeoutSeconds: 30 } });
    await send(sqs, queues.queueUrl, envelope(wallet));
    await gate.started;

    await stop(app);
    // Visível de novo bem antes dos 30s de visibilidade: foi devolvida no shutdown.
    await eventually(async () => expect(await visibleCount(sqs, queues.queueUrl)).toBe(1), 5_000);

    await start();
    gate.open(); // o processamento abandonado segue ao mesmo tempo que a nova instância
    await expectDrained();
    await eventually(() => expect(gate.finished()).toBe(1));
    expect(await debits(wallet.walletId)).toBe(1);
    expect(await countRows(orm, 'inbox_messages')).toBe(1);
    await expectLedgerConsistent(orm, wallet.walletId);
  });
});
