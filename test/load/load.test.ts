import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { DeleteMessageBatchCommand, ReceiveMessageCommand, type SQSClient } from '@aws-sdk/client-sqs';
import type { MikroORM } from '@mikro-orm/postgresql';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { loadConfig } from '../../src/infrastructure/config/app-config';
import { createSqsClient } from '../../src/infrastructure/messaging/sqs.client';
import { openOrm, truncateAll } from '../integration/persistence/db';
import { createQueues, deleteQueues, queueDepth, send, type TestQueues } from '../integration/interfaces/sqs-harness';
import { createEventsQueue, deleteQueue } from '../integration/workers/outbox-harness';
import { expectConsistent, waitQuiescence } from '../multi/consistency';
import { callWithRetry, cents, eventually, freePort, Instance, prng, seedFromEnv } from '../multi/harness';
import {
  collectEnvironment,
  counterDelta,
  intFromEnv,
  levelsFromEnv,
  percentiles,
  printSummary,
  scrape,
  type MetricSnapshot,
} from './measure';

/**
 * Teste de carga (CHALLENGE §14, "Diferenciais opcionais"). Só roda com LOAD=1 (`bun run test:load`).
 *
 * 3 processos reais da aplicação (harness do test/multi: API + consumidor + outbox publisher +
 * worker de pendentes) sobre o Postgres e o LocalStack do compose. Três cenários × níveis de
 * concorrência, cada rodada com aquecimento descartado e janela de medição fixa, e ao fim as
 * mesmas verificações de consistência do test:multi. Cada rodada começa com as tabelas vazias
 * (TRUNCATE). Metodologia e limitações: ARCHITECTURE.md → "Estratégia de testes".
 */

const ENABLED = process.env['LOAD'] === '1';
const SEED = seedFromEnv(process.env['LOAD_SEED'], 20261108);
const LEVELS = levelsFromEnv('LOAD_LEVELS', [10, 50]);
const WARMUP_S = intFromEnv('LOAD_WARMUP_S', 10);
const DURATION_S = intFromEnv('LOAD_DURATION_S', 45);
/** Mensagens/s de cada produtor SQS no cenário misto (taxa fixa: chegada aberta). */
const SQS_RATE = intFromEnv('LOAD_SQS_RATE', 5);
const SCENARIO_FILTER = process.env['LOAD_SCENARIOS']?.split(',').map((s) => s.trim()).filter(Boolean);
const PROVIDER = 'provider-load';
const RESULTS_DIR = join(import.meta.dir, 'results');

type Payload = Record<string, unknown>;
type Wallet = { id: string; playerId: string };
type Client = { id: number; rr: number; rand: () => number };

/** Tudo o que uma rodada (cenário × nível) mede. Só entra o que COMEÇA dentro da janela. */
class RunRecorder {
  windowStart = Number.POSITIVE_INFINITY;
  windowEnd = Number.POSITIVE_INFINITY;
  readonly latencies: number[] = [];
  readonly statuses = new Map<string, number>();
  readonly failureCodes = new Map<string, number>();
  clientRetries = 0;
  logicalOps = 0;
  /** messageId → instante do início do SendMessage (só o primeiro envio daquele id, dentro da janela). */
  readonly sqsSentAt = new Map<string, number>();
  sqsSentInWindow = 0;
  sqsSendErrors = 0;
  readonly mix = new Map<string, number>();
  readonly samples: Array<{ t: number; lagMs: number; outboxPending: number; queueDepth: number }> = [];

  inWindow(t: number): boolean {
    return t >= this.windowStart && t < this.windowEnd;
  }
  bump(map: Map<string, number>, key: string, by = 1): void {
    map.set(key, (map.get(key) ?? 0) + by);
  }
}

describe.skipIf(!ENABLED)(`carga: 3 instâncias, níveis ${LEVELS.join('/')} (seed ${SEED})`, () => {
  let orm: MikroORM;
  let sqs: SQSClient;
  let queues: TestQueues;
  let events: { name: string; url: string };
  let instanceEnv: Record<string, string>;
  const instances: Instance[] = [];
  const runs: Array<Record<string, unknown>> = [];
  let environment: Record<string, unknown> = {};
  /** eventIds lidos da fila de eventos por um consumidor de fundo (o "downstream"). */
  const deliveredEventIds = new Set<string>();
  let deliveredMessages = 0;
  let draining = true;
  const drainers: Array<Promise<void>> = [];

  const rows = async <T>(sql: string, bindings: string[] = []): Promise<T[]> =>
    (await orm.em.getKnex().raw<{ rows: T[] }>(sql, bindings)).rows;

  async function drainEvents(): Promise<void> {
    while (draining) {
      try {
        const { Messages = [] } = await sqs.send(
          new ReceiveMessageCommand({ QueueUrl: events.url, MaxNumberOfMessages: 10, WaitTimeSeconds: 1, VisibilityTimeout: 300 }),
        );
        if (Messages.length === 0) continue;
        for (const message of Messages) {
          deliveredMessages++;
          deliveredEventIds.add((JSON.parse(message.Body ?? '{}') as { eventId: string }).eventId);
        }
        await sqs.send(
          new DeleteMessageBatchCommand({
            QueueUrl: events.url,
            Entries: Messages.map((message, index) => ({ Id: String(index), ReceiptHandle: message.ReceiptHandle })),
          }),
        );
      } catch {
        if (draining) await Bun.sleep(200);
      }
    }
  }

  beforeAll(async () => {
    sqs = createSqsClient(loadConfig());
    orm = await openOrm();
    await truncateAll(orm);
    queues = await createQueues(sqs);
    events = await createEventsQueue(sqs);
    instanceEnv = {
      NODE_ENV: 'test',
      SQS_CONSUMER_ENABLED: 'true',
      OUTBOX_PUBLISHER_ENABLED: 'true',
      PENDING_REFERENCE_WORKER_ENABLED: 'true',
      SQS_WAGER_QUEUE_NAME: queues.queueName,
      SQS_WAGER_DLQ_NAME: queues.dlqName,
      SQS_WAGER_EVENTS_QUEUE_NAME: events.name,
      // Único desvio dos padrões de produção: o backoff de retry do consumidor (30s–300s) faria
      // um lock_timeout eventual segurar a quiescência por minutos. Não muda o caminho feliz.
      SQS_RETRY_BASE_SECONDS: '1',
      SQS_RETRY_MAX_SECONDS: '5',
    };
    const live = await Promise.all(['A', 'B', 'C'].map(async (label) => new Instance(label, await freePort(), instanceEnv)));
    instances.push(...live);
    live.forEach((instance) => instance.start());
    await Promise.all(live.map((instance) => instance.waitReady()));
    environment = await collectEnvironment(rows, instanceEnv);
    for (let i = 0; i < 4; i++) drainers.push(drainEvents());
    console.log(`[load] ambiente: ${JSON.stringify(environment)}`);
  }, 120_000);

  afterAll(async () => {
    draining = false;
    await Promise.allSettled(drainers);
    await Promise.all(instances.map((instance) => instance.kill()));
    if (runs.length > 0) {
      await mkdir(RESULTS_DIR, { recursive: true });
      const file = join(RESULTS_DIR, `${new Date().toISOString().replaceAll(':', '-').slice(0, 19)}.json`);
      const methodology = {
        seed: SEED,
        levels: LEVELS,
        warmupSeconds: WARMUP_S,
        measureSeconds: DURATION_S,
        sqsRatePerProducer: SQS_RATE,
        httpClients: 'laço fechado: cada cliente envia, espera a resposta e envia de novo; rodízio entre as 3 instâncias',
        sqsProducers: 'cenário misto: taxa fixa por produtor (chegada aberta)',
        latency: 'por tentativa HTTP, medida no cliente (inclui rede local e fila do pool); só tentativas iniciadas na janela',
        endToEnd: 'início do SendMessage (cliente) → inbox_messages.processed_at (commit do consumidor); mesmo relógio do host',
        outboxLag: 'amostrado a cada 1s: agora − min(occurred_at) das linhas não publicadas',
        tables: 'cada rodada começa com as tabelas vazias (TRUNCATE)',
      };
      await Bun.write(file, JSON.stringify({ environment, methodology, runs }, null, 2));
      printSummary(runs as Array<Record<string, any>>);
      console.log(`\n[load] resultados brutos: ${file}`);
    }
    await Promise.allSettled([deleteQueues(sqs, queues), deleteQueue(sqs, events.url)]);
    await orm.close(true);
    sqs.destroy();
  }, 60_000);

  // ───────────────────────── Clientes

  /** POST com a mesma key até resposta definitiva; 503 e falha de rede são reenviados (contrato do provedor). */
  async function post(run: RunRecorder, client: Client, path: string, body: Payload, key?: string): Promise<{ status: number; body: Record<string, any> }> {
    for (let attempt = 1; attempt <= 40; attempt++) {
      const instance = instances[client.rr++ % instances.length]!;
      const startedAt = Date.now();
      const t0 = performance.now();
      let status = 0;
      let parsed: Record<string, any> = {};
      try {
        const response = await fetch(`${instance.url}${path}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', ...(key ? { 'idempotency-key': key } : {}) },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(15_000),
        });
        status = response.status;
        const text = await response.text();
        try {
          parsed = text ? (JSON.parse(text) as Record<string, any>) : {};
        } catch {
          // corpo não-JSON: só o status importa
        }
      } catch {
        // falha de rede/timeout: status 0
      }
      if (run.inWindow(startedAt)) {
        run.latencies.push(performance.now() - t0);
        run.bump(run.statuses, String(status));
        if (status === 422) run.bump(run.failureCodes, String(parsed['failureCode'] ?? '?'));
      }
      if (status !== 503 && status !== 0) return { status, body: parsed };
      if (run.inWindow(startedAt)) run.clientRetries++;
      await Bun.sleep(Math.min(1_000, 50 * attempt));
    }
    throw new Error(`POST ${path} sem resposta definitiva em 40 tentativas`);
  }

  async function sqsSend(run: RunRecorder, data: Payload, messageId: string, dedupId = messageId): Promise<void> {
    const startedAt = Date.now();
    try {
      await send(
        sqs,
        queues.queueUrl,
        {
          messageId,
          type: 'WagerTransactionRequested',
          occurredAt: new Date(startedAt).toISOString(),
          data: { ...data, idempotencyKey: keyOf(data) },
        },
        { dedupId, groupId: data['walletId'] as string },
      );
      if (run.inWindow(startedAt)) {
        run.sqsSentInWindow++;
        if (!run.sqsSentAt.has(messageId)) run.sqsSentAt.set(messageId, startedAt);
      }
    } catch {
      run.sqsSendErrors++;
    }
  }

  const keyOf = (data: Payload) => `${PROVIDER}:${data['externalTransactionId'] as string}`;
  const amount = (rand: () => number, min: number, max: number) => BigInt(min + Math.floor(rand() * (max - min + 1)));
  let seq = 0;
  const extId = (tag: string, prefix: string) => `${tag}-${prefix}-${++seq}`;

  function payload(wallet: Wallet, externalTransactionId: string, kind: string, value: bigint, extra: Payload = {}): Payload {
    return {
      providerId: PROVIDER,
      externalTransactionId,
      playerId: wallet.playerId,
      walletId: wallet.id,
      roundId: `round-${externalTransactionId}`,
      gameId: 'game-load',
      kind,
      money: { amount: cents(value), currency: 'BRL' },
      ...extra,
    };
  }

  async function openWallets(tag: string, count: number, start: bigint): Promise<Wallet[]> {
    const wallets: Wallet[] = [];
    for (let offset = 0; offset < count; offset += 25) {
      const chunk = Array.from({ length: Math.min(25, count - offset) }, (_, i) => offset + i);
      const created = await Promise.all(
        chunk.map(async (i) => {
          const playerId = `${tag}-player-${i}`;
          const response = await callWithRetry(instances, i, 'POST', '/wallets', {
            body: { playerId, initialBalance: { amount: cents(start), currency: 'BRL' } },
          });
          // Reenvio depois de um commit cuja resposta se perdeu volta 409 com o id (ARCHITECTURE.md → "API HTTP").
          const id = (response.status === 201 ? response.body['id'] : response.body['error']?.['walletId']) as string | undefined;
          if (!id) throw new Error(`POST /wallets ${playerId}: ${response.status} ${JSON.stringify(response.body)}`);
          return { id, playerId };
        }),
      );
      wallets.push(...created);
    }
    return wallets;
  }

  // ───────────────────────── Cenários

  interface Scenario {
    name: string;
    describe: string;
    split(level: number): { http: number; sqs: number };
    setup(tag: string): Promise<{
      http?: (run: RunRecorder, client: Client) => Promise<void>;
      /** Devolve quantas mensagens enviou (para a taxa fixa). */
      sqs?: (run: RunRecorder, client: Client) => Promise<number>;
    }>;
  }

  const pick = <T>(rand: () => number, items: readonly T[]): T => items[Math.floor(rand() * items.length)]!;

  const scenarios: Scenario[] = [
    {
      name: 'wallet-disputada',
      describe: '1 wallet (10.000.000,00), BET/WIN 50/50 de 1,00–10,00 com keys únicas, só HTTP',
      split: (level) => ({ http: level, sqs: 0 }),
      async setup(tag) {
        const [wallet] = await openWallets(tag, 1, 1_000_000_000n);
        return {
          http: async (run, client) => {
            const kind = client.rand() < 0.5 ? 'BET' : 'WIN';
            const data = payload(wallet!, extId(tag, kind.toLowerCase()), kind, amount(client.rand, 100, 1_000));
            await post(run, client, '/wagering/transactions', data, keyOf(data));
            if (run.inWindow(Date.now())) run.logicalOps++;
          },
        };
      },
    },
    {
      name: 'muitas-wallets',
      describe: '300 wallets (10.000,00), BET/WIN/LOSS 60/30/10 de 1,00–20,00 em wallet aleatória, só HTTP',
      split: (level) => ({ http: level, sqs: 0 }),
      async setup(tag) {
        const wallets = await openWallets(tag, 300, 1_000_000n);
        return {
          http: async (run, client) => {
            const r = client.rand();
            const kind = r < 0.6 ? 'BET' : r < 0.9 ? 'WIN' : 'LOSS';
            const data = payload(pick(client.rand, wallets), extId(tag, kind.toLowerCase()), kind, amount(client.rand, 100, 2_000));
            await post(run, client, '/wagering/transactions', data, keyOf(data));
            if (run.inWindow(Date.now())) run.logicalOps++;
          },
        };
      },
    },
    {
      name: 'misto',
      describe:
        '200 wallets (1.000,00); metade dos clientes HTTP (laço fechado), metade produtores SQS (taxa fixa); ' +
        '10% reenvio duplicado, 5% REFUND/ROLLBACK antes da BET, 5% BET acima do saldo, resto BET/WIN/LOSS 50/35/15',
      split: (level) => ({ http: Math.ceil(level / 2), sqs: Math.floor(level / 2) }),
      async setup(tag) {
        const wallets = await openWallets(tag, 200, 100_000n);
        /** Envios recentes (qualquer canal), para reenvio com a mesma key. */
        const recent: Array<{ data: Payload; messageId?: string }> = [];
        const remember = (data: Payload, messageId?: string) => {
          recent.push(messageId === undefined ? { data } : { data, messageId });
          if (recent.length > 500) recent.shift();
        };
        type Op = { kind: 'dup' | 'reversal' | 'oversize' | 'normal' };
        const choose = (rand: () => number): Op['kind'] => {
          const r = rand();
          if (r < 0.1 && recent.length > 0) return 'dup';
          if (r < 0.15) return 'reversal';
          if (r < 0.2) return 'oversize';
          return 'normal';
        };
        const normal = (rand: () => number): Payload => {
          const r = rand();
          const kind = r < 0.5 ? 'BET' : r < 0.85 ? 'WIN' : 'LOSS';
          return payload(pick(rand, wallets), extId(tag, kind.toLowerCase()), kind, amount(rand, 100, 2_000));
        };
        /** REFUND/ROLLBACK que chega ANTES da BET referenciada (mesmo roundId e valor). */
        const reversalPair = (rand: () => number): [Payload, Payload] => {
          const wallet = pick(rand, wallets);
          const betId = extId(tag, 'refbet');
          const value = amount(rand, 100, 2_000);
          const kind = rand() < 0.5 ? 'REFUND' : 'ROLLBACK';
          const roundId = `round-${betId}`;
          const reversal = payload(wallet, extId(tag, kind.toLowerCase()), kind, value, { roundId, referenceExternalTransactionId: betId });
          return [reversal, payload(wallet, betId, 'BET', value, { roundId })];
        };
        const oversize = (rand: () => number) => payload(pick(rand, wallets), extId(tag, 'big'), 'BET', 100_000_000n);
        let messageSeq = 0;
        const messageId = () => `${tag}-m-${++messageSeq}`;

        return {
          http: async (run, client) => {
            const op = choose(client.rand);
            if (run.inWindow(Date.now())) run.bump(run.mix, `http:${op}`);
            if (op === 'reversal') {
              const [reversal, bet] = reversalPair(client.rand);
              await post(run, client, '/wagering/transactions', reversal, keyOf(reversal));
              await post(run, client, '/wagering/transactions', bet, keyOf(bet));
              remember(bet);
            } else {
              const data = op === 'dup' ? pick(client.rand, recent).data : op === 'oversize' ? oversize(client.rand) : normal(client.rand);
              await post(run, client, '/wagering/transactions', data, keyOf(data));
              if (op !== 'dup') remember(data);
            }
            if (run.inWindow(Date.now())) run.logicalOps++;
          },
          sqs: async (run, client) => {
            const op = choose(client.rand);
            if (run.inWindow(Date.now())) run.bump(run.mix, `sqs:${op}`);
            if (op === 'reversal') {
              // Mesmo grupo (walletId): a FIFO entrega a reversão antes da BET.
              const [reversal, bet] = reversalPair(client.rand);
              await sqsSend(run, reversal, messageId());
              const betMessage = messageId();
              await sqsSend(run, bet, betMessage);
              remember(bet, betMessage);
              return 2;
            }
            if (op === 'dup') {
              const previous = pick(client.rand, recent);
              if (previous.messageId !== undefined && client.rand() < 0.5) {
                // Mesmo messageId, dedup do broker diferente: a inbox reconhece (DUPLICATE_MESSAGE).
                await sqsSend(run, previous.data, previous.messageId, `${previous.messageId}#${++messageSeq}`);
              } else {
                // messageId novo, mesma key: o use case devolve o replay idempotente.
                await sqsSend(run, previous.data, messageId());
              }
              return 1;
            }
            const data = op === 'oversize' ? oversize(client.rand) : normal(client.rand);
            const id = messageId();
            await sqsSend(run, data, id);
            remember(data, id);
            return 1;
          },
        };
      },
    },
  ];

  // ───────────────────────── Rodadas

  const selected = scenarios.filter((scenario) => !SCENARIO_FILTER || SCENARIO_FILTER.includes(scenario.name));
  let runIndex = 0;

  for (const scenario of selected) {
    for (const level of LEVELS) {
      it(
        `${scenario.name} com ${level} clientes`,
        async () => {
          const index = ++runIndex;
          const tag = `r${index}`;
          const run = new RunRecorder();
          const result: Record<string, any> = { scenario: scenario.name, description: scenario.describe, clients: level };
          runs.push(result);
          const log = (message: string) => console.log(`[load ${scenario.name}/${level}] ${message}`);

          // Tabelas vazias no início de toda rodada: o volume da anterior não contamina esta.
          await truncateAll(orm);
          deliveredEventIds.clear();
          deliveredMessages = 0;
          const plan = await scenario.setup(tag);
          const split = scenario.split(level);
          result['split'] = split;

          const traffic = (instance: Instance) => ({ http: instance.count('wager_transaction_processed@http'), sqsAcked: instance.count('sqs_message_acked') });
          const trafficBefore = instances.map(traffic);
          const runStartMetrics = await scrape(instances);

          const begin = Date.now();
          run.windowStart = begin + WARMUP_S * 1_000;
          run.windowEnd = run.windowStart + DURATION_S * 1_000;
          log(`aquecimento ${WARMUP_S}s + medição ${DURATION_S}s (HTTP ${split.http}, SQS ${split.sqs})`);

          // Amostrador de 1s: outbox lag e profundidade da fila, do início até a quiescência.
          let sampling = true;
          const sampler = (async () => {
            while (sampling) {
              const tickStart = Date.now();
              try {
                const [[outbox], depth] = await Promise.all([
                  rows<{ n: number; oldest: number | null }>(
                    `select count(*)::int as n, (extract(epoch from min(occurred_at)) * 1000)::float8 as oldest
                       from outbox_messages where published_at is null`,
                  ),
                  queueDepth(sqs, queues.queueUrl),
                ]);
                run.samples.push({
                  t: tickStart,
                  lagMs: outbox?.oldest ? Math.max(0, tickStart - outbox.oldest) : 0,
                  outboxPending: outbox?.n ?? 0,
                  queueDepth: depth,
                });
              } catch {
                // amostra perdida: segue
              }
              await Bun.sleep(Math.max(0, 1_000 - (Date.now() - tickStart)));
            }
          })();

          const clients: Array<Promise<void>> = [];
          const newClient = (id: number): Client => ({ id, rr: id, rand: prng(SEED + index * 10_000 + id) });
          for (let i = 0; i < split.http; i++) {
            const client = newClient(i);
            clients.push(
              (async () => {
                while (Date.now() < run.windowEnd) await plan.http!(run, client);
              })(),
            );
          }
          for (let i = 0; i < split.sqs; i++) {
            const client = newClient(1_000 + i);
            clients.push(
              (async () => {
                // Taxa fixa: o próximo envio é agendado pelo relógio, não pela resposta.
                let next = Date.now() + client.rand() * (1_000 / SQS_RATE);
                while (Date.now() < run.windowEnd) {
                  await Bun.sleep(Math.max(0, next - Date.now()));
                  const sent = await plan.sqs!(run, client);
                  next += (sent * 1_000) / SQS_RATE;
                }
              })(),
            );
          }

          await Bun.sleep(Math.max(0, run.windowStart - Date.now()));
          const windowStartMetrics = await scrape(instances);
          await Bun.sleep(Math.max(0, run.windowEnd - Date.now()));
          const windowEndMetrics = await scrape(instances);
          await Promise.all(clients);
          log('carga encerrada; esperando a quiescência');

          const quiesceStart = Date.now();
          await waitQuiescence(rows, sqs, queues.queueUrl, 240_000);
          result['quiescenceMs'] = Date.now() - quiesceStart;
          sampling = false;
          await sampler;
          const runEndMetrics = await scrape(instances);

          // ── Throughput pelo banco (relógio da aplicação = relógio do host)
          const [db] = await rows<{ created: string; processed: string; rejected_in_window: string }>(
            `select count(*) filter (where kind <> 'OPENING' and created_at >= to_timestamp(?::float8 / 1000) and created_at < to_timestamp(?::float8 / 1000))::text as created,
                    count(*) filter (where kind <> 'OPENING' and status = 'PROCESSED'
                                       and processed_at >= to_timestamp(?::float8 / 1000) and processed_at < to_timestamp(?::float8 / 1000))::text as processed,
                    count(*) filter (where kind <> 'OPENING' and status = 'REJECTED'
                                       and created_at >= to_timestamp(?::float8 / 1000) and created_at < to_timestamp(?::float8 / 1000))::text as rejected_in_window
               from wager_transactions`,
            [run.windowStart, run.windowEnd, run.windowStart, run.windowEnd, run.windowStart, run.windowEnd].map(String),
          );
          const [totals] = await rows<Record<string, string>>(
            `select count(*) filter (where kind <> 'OPENING')::text as transactions,
                    count(*) filter (where kind <> 'OPENING' and status = 'PROCESSED')::text as processed,
                    count(*) filter (where status = 'REJECTED')::text as rejected,
                    count(*) filter (where status = 'FAILED')::text as failed,
                    count(*) filter (where kind in ('REFUND','ROLLBACK'))::text as reversals,
                    (select count(*) from wallet_ledger_entries)::text as ledger_entries,
                    (select count(*) from inbox_messages)::text as inbox,
                    (select count(*) from outbox_messages)::text as outbox
               from wager_transactions`,
          );
          const failureCodesDb = await rows<{ failure_code: string; n: string }>(
            `select failure_code, count(*)::text as n from wager_transactions where status = 'REJECTED' group by 1 order by 2 desc`,
          );
          result['throughput'] = {
            transactionsPerSecond: Number(db?.created) / DURATION_S,
            processedPerSecond: Number(db?.processed) / DURATION_S,
            rejectedPerSecond: Number(db?.rejected_in_window) / DURATION_S,
            createdInWindow: Number(db?.created),
            processedInWindow: Number(db?.processed),
          };
          result['database'] = { totals, rejectedByFailureCode: Object.fromEntries(failureCodesDb.map((r) => [r.failure_code, Number(r.n)])) };

          // ── HTTP
          const statuses = Object.fromEntries(run.statuses);
          const attempts = run.latencies.length;
          const count = (predicate: (status: number) => boolean) =>
            [...run.statuses].filter(([status]) => predicate(Number(status))).reduce((total, [, n]) => total + n, 0);
          const errors = count((s) => s === 0 || s >= 500);
          result['http'] = {
            attempts,
            logicalOps: run.logicalOps,
            requestsPerSecond: attempts / DURATION_S,
            latencyMs: percentiles(run.latencies),
            statuses,
            ok2xx: count((s) => s >= 200 && s < 300),
            business422: count((s) => s === 422),
            unexpected4xx: count((s) => s >= 400 && s < 500 && s !== 422),
            errors,
            errorRate: attempts === 0 ? 0 : errors / attempts,
            clientRetries: run.clientRetries,
            failureCodes422: Object.fromEntries(run.failureCodes),
          };
          result['mix'] = Object.fromEntries(run.mix);

          // ── Fila: ponta a ponta pelo banco
          const ids = [...run.sqsSentAt.keys()];
          const processedAt =
            ids.length === 0
              ? []
              : (
                  await orm.em
                    .getKnex()
                    .raw<{ rows: Array<{ message_id: string; t: number | null }> }>(
                      `select message_id, (extract(epoch from processed_at) * 1000)::float8 as t from inbox_messages where message_id = any(?::text[])`,
                      [ids],
                    )
                ).rows;
          const endToEnd = processedAt.filter((r) => r.t !== null).map((r) => r.t! - run.sqsSentAt.get(r.message_id)!);
          const windowSamples = run.samples.filter((s) => run.inWindow(s.t));
          result['queue'] = {
            sentInWindow: run.sqsSentInWindow,
            sendErrors: run.sqsSendErrors,
            sendsPerSecond: run.sqsSentInWindow / DURATION_S,
            distinctMessageIdsMeasured: ids.length,
            notFoundInInbox: ids.length - endToEnd.length,
            endToEndMs: percentiles(endToEnd),
            depth: {
              max: Math.max(0, ...windowSamples.map((s) => s.queueDepth)),
              p95: percentiles(windowSamples.map((s) => s.queueDepth)).p95,
              maxUntilQuiescence: Math.max(0, ...run.samples.map((s) => s.queueDepth)),
            },
          };
          result['outbox'] = {
            lagMs: { ...percentiles(windowSamples.map((s) => s.lagMs)), maxUntilQuiescence: Math.max(0, ...run.samples.map((s) => s.lagMs)) },
            pendingMax: Math.max(0, ...windowSamples.map((s) => s.outboxPending)),
          };
          result['samples'] = run.samples.map((s) => ({ ...s, t: s.t - begin }));

          // ── /metrics: delta das 3 instâncias
          const counters = [
            'wagering_lock_conflicts_total',
            'wagering_retries_total',
            'wagering_dlq_messages_total',
            'wagering_idempotent_replays_total',
            'wagering_idempotency_conflicts_total',
            'wagering_transactions_total',
            'wagering_outbox_published_total',
            'wagering_outbox_publish_failures_total',
            'wagering_outbox_retries_total',
            'wagering_pending_reference_resolved_total',
            'wagering_pending_reference_expired_total',
            'wagering_pending_reference_rescheduled_total',
            'wagering_pending_reference_skipped_total',
          ];
          const delta = (a: MetricSnapshot, b: MetricSnapshot) => counterDelta(a, b, counters);
          result['metrics'] = { window: delta(windowStartMetrics, windowEndMetrics), wholeRun: delta(runStartMetrics, runEndMetrics) };

          // ── Distribuição entre as instâncias (desde o início da rodada, inclui aquecimento)
          result['perInstance'] = instances.map((instance, i) => {
            const now = traffic(instance);
            return { label: instance.label, pid: instance.pid, http: now.http - trafficBefore[i]!.http, sqsAcked: now.sqsAcked - trafficBefore[i]!.sqsAcked };
          });

          // ── Consistência (as mesmas verificações do test:multi)
          const [outboxCount] = await rows<{ n: string }>('select count(*)::text as n from outbox_messages');
          try {
            await eventually(
              'todo eventId da outbox lido da fila de eventos',
              () => {
                if (deliveredEventIds.size < Number(outboxCount?.n)) {
                  throw new Error(`${deliveredEventIds.size} de ${outboxCount?.n}`);
                }
              },
              120_000,
              250,
            );
            await expectConsistent(rows, { deliveredEventIds, dlqDepth: await queueDepth(sqs, queues.dlqUrl) });
            expect(result['http'].unexpected4xx, `respostas 4xx fora de 422: ${JSON.stringify(statuses)}`).toBe(0);
            expect(result['queue'].notFoundInInbox, 'mensagens enviadas na janela sem registro na inbox').toBe(0);
            for (const instance of result['perInstance'] as Array<{ label: string; http: number; sqsAcked: number }>) {
              expect(instance.http, `${instance.label} atendeu HTTP`).toBeGreaterThan(0);
              if (split.sqs > 0) expect(instance.sqsAcked, `${instance.label} confirmou mensagens SQS`).toBeGreaterThan(0);
            }
            result['consistency'] = { ok: true, outboxEvents: Number(outboxCount?.n), eventMessagesReceived: deliveredMessages };
          } catch (error) {
            result['consistency'] = { ok: false, error: error instanceof Error ? error.message : String(error) };
            for (const instance of instances) console.error(instance.logTail(10));
            throw error;
          }
          log(
            `ok: ${result['http'].requestsPerSecond.toFixed(1)} req/s, p99 ${result['http'].latencyMs.p99.toFixed(1)}ms, ` +
              `quiescência ${(result['quiescenceMs'] / 1000).toFixed(1)}s, consistência ok`,
          );
        },
        (WARMUP_S + DURATION_S) * 1_000 + 480_000,
      );
    }
  }
});
