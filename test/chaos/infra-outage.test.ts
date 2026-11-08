import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import type { SQSClient } from '@aws-sdk/client-sqs';
import type { MikroORM } from '@mikro-orm/postgresql';
import { loadConfig } from '../../src/infrastructure/config/app-config';
import { createSqsClient } from '../../src/infrastructure/messaging/sqs.client';
import { openOrm, truncateAll } from '../integration/persistence/db';
import { createQueues, deleteQueues, queueDepth, readDlq, send, type TestQueues } from '../integration/interfaces/sqs-harness';
import { createEventsQueue, deleteQueue, drain } from '../integration/workers/outbox-harness';
import { ROOT, callWithRetry, cents, eventually, freePort, Instance } from '../multi/harness';

/**
 * CHALLENGE §3: "PostgreSQL e SQS podem ficar temporariamente indisponíveis".
 *
 * Duas instâncias reais da aplicação (API + consumidor + publisher + worker de pendentes) sob
 * carga, com a dependência derrubada de verdade:
 *  - Postgres: `docker compose stop` / `start` por ~40s (conexões recusadas; a imagem para com fast shutdown).
 *  - LocalStack: `docker compose pause` / `unpause` por ~12s (um stop apagaria as filas da suíte).
 * Tudo é verificado por comportamento: 503 na API, retries > 0, nada na DLQ, nada perdido,
 * consistência final por SQL. Só roda com CHAOS=1 (`bun run test:chaos`): pausa containers
 * compartilhados, então fica fora do `bun test` e das outras suítes.
 */
const ENABLED = process.env['CHAOS'] === '1';
/** LocalStack pausado. */
const SQS_OUTAGE_MS = 12_000;
/**
 * Postgres parado: acima da tolerância que o consumidor tinha antes do modo "banco fora" (com os
 * números desta suíte, 5 tentativas com backoff 2/4/8/8s = 22s). Sem o modo, as mensagens válidas
 * recebidas na queda iriam para a DLQ com MAX_ATTEMPTS_EXCEEDED.
 */
const PG_OUTAGE_MS = 40_000;
const PROVIDER = 'provider-a';
const BET = 1_000n; // 10.00

type Wallet = { id: string; playerId: string; expected: bigint };

/** Resumo de cada fase na saída do teste (evidência em docs/carga/chaos.txt). */
function report(phase: string, values: Record<string, unknown>): void {
  console.log(`[chaos] ${phase}: ${JSON.stringify(values)}`);
}

async function compose(...args: string[]): Promise<void> {
  const proc = Bun.spawn(['docker', 'compose', ...args], { cwd: ROOT, stdout: 'pipe', stderr: 'pipe' });
  const code = await proc.exited;
  if (code !== 0) throw new Error(`docker compose ${args.join(' ')} saiu com ${code}: ${await new Response(proc.stderr).text()}`);
}

describe.skipIf(!ENABLED)('chaos: Postgres e SQS temporariamente indisponíveis', () => {
  let orm: MikroORM;
  let sqs: SQSClient;
  let queues: TestQueues;
  let events: { name: string; url: string };
  const instances: Instance[] = [];
  const wallets: Wallet[] = [];
  let pick = 0;
  /** Containers derrubados por este teste e ainda não restaurados (o afterAll restaura). */
  const down = new Set<'postgres-stopped' | 'localstack-paused'>();

  const rows = async <T>(sql: string, bindings: unknown[] = []): Promise<T[]> =>
    (await orm.em.getKnex().raw<{ rows: T[] }>(sql, bindings as never)).rows;

  const env = (): Record<string, string> => ({
    NODE_ENV: 'test',
    SQS_CONSUMER_ENABLED: 'true',
    OUTBOX_PUBLISHER_ENABLED: 'true',
    PENDING_REFERENCE_WORKER_ENABLED: 'true',
    SQS_WAGER_QUEUE_NAME: queues.queueName,
    SQS_WAGER_DLQ_NAME: queues.dlqName,
    SQS_WAGER_EVENTS_QUEUE_NAME: events.name,
    // Só nesta suíte: tempos curtos. Sem conexão com o banco, o consumidor para de receber (modo
    // "banco fora") e as tentativas não se esgotam: a queda de 40s passa dos 22s que 5 tentativas
    // com backoff 2/4/8/8s cobririam, e mesmo assim nada pode ir para a DLQ.
    SQS_WAIT_TIME_SECONDS: '1',
    SQS_VISIBILITY_TIMEOUT_SECONDS: '5',
    SQS_RETRY_BASE_SECONDS: '2',
    SQS_RETRY_MAX_SECONDS: '8',
    SQS_CONSUMER_MAX_ATTEMPTS: '5',
    OUTBOX_POLL_INTERVAL_MS: '200',
    OUTBOX_SQS_TIMEOUT_MS: '2000',
    PENDING_REFERENCE_POLL_INTERVAL_MS: '300',
    PENDING_REFERENCE_TTL_MS: '120000',
  });

  const payload = (wallet: Wallet, ext: string, kind = 'BET', extra: Record<string, unknown> = {}) => ({
    providerId: PROVIDER,
    externalTransactionId: ext,
    playerId: wallet.playerId,
    walletId: wallet.id,
    roundId: `round-${ext.replace(/^(rb|bet)-/, '')}`,
    gameId: 'game-1',
    kind,
    money: { amount: cents(BET), currency: 'BRL' },
    ...extra,
  });

  /** Uma tentativa só, sem retry: o teste quer ver o status que o provedor receberia. */
  async function submitOnce(data: Record<string, unknown>): Promise<{ status: number; retryAfter: string | null; body: string }> {
    const instance = instances[pick++ % instances.length]!;
    const response = await fetch(`${instance.url}/wagering/transactions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'idempotency-key': `${PROVIDER}:${data['externalTransactionId'] as string}` },
      body: JSON.stringify(data),
      signal: AbortSignal.timeout(30_000),
    });
    return { status: response.status, retryAfter: response.headers.get('retry-after'), body: await response.text() };
  }

  const submitWithRetry = (data: Record<string, unknown>) =>
    callWithRetry(instances, pick++, 'POST', '/wagering/transactions', {
      body: data,
      headers: { 'idempotency-key': `${PROVIDER}:${data['externalTransactionId'] as string}` },
    });

  const submitSqs = (data: Record<string, unknown>) =>
    send(sqs, queues.queueUrl, {
      messageId: `m-${data['externalTransactionId'] as string}`,
      type: 'WagerTransactionRequested',
      occurredAt: new Date().toISOString(),
      data: { ...data, idempotencyKey: `${PROVIDER}:${data['externalTransactionId'] as string}` },
    }, { groupId: data['walletId'] as string });

  /** Soma de um contador do Prometheus em todas as instâncias. */
  async function metric(name: string): Promise<number> {
    let total = 0;
    for (const instance of instances) {
      const text = await (await fetch(`${instance.url}/metrics`)).text();
      for (const line of text.split('\n')) {
        if (line.startsWith(name) && !line.startsWith('#')) total += Number(line.split(' ').at(-1));
      }
    }
    return total;
  }

  async function waitReady(): Promise<void> {
    await Promise.all(instances.map((instance) => instance.waitReady(90_000)));
  }

  async function quiescent(): Promise<void> {
    await eventually(
      'quiescente: fila vazia, outbox publicada, nada pendente',
      async () => {
        for (let read = 0; read < 2; read++) {
          expect(await queueDepth(sqs, queues.queueUrl), 'fila principal').toBe(0);
          const [row] = await rows<{ outbox: string; waiting: string }>(
            `select (select count(*) from outbox_messages where published_at is null)::text as outbox,
                    (select count(*) from wager_transactions where status in ('PENDING','PENDING_REFERENCE'))::text as waiting`,
          );
          expect(row).toEqual({ outbox: '0', waiting: '0' });
          if (read === 0) await Bun.sleep(300); // contagens do SQS são aproximadas
        }
      },
      120_000,
      250,
    );
  }

  /** Invariantes finais, por SQL e pelas filas. `fromSeq`: só os eventos desta fase. */
  async function expectConsistent(fromSeq: number, externals: string[]): Promise<void> {
    expect(await readDlq(sqs, queues.dlqUrl), 'nada na DLQ').toEqual([]);
    const diverging = await rows(
      `select w.id from wallets w left join wallet_ledger_entries l on l.wallet_id = w.id
        group by w.id, w.balance
       having w.balance <> coalesce(sum(case l.direction when 'CREDIT' then l.amount else -l.amount end), 0)`,
    );
    expect(diverging, 'saldo == ledger em todas as wallets').toEqual([]);
    expect(await rows('select id from wallets where balance < 0'), 'nenhum saldo negativo').toEqual([]);
    const perExternal = await rows<{ ext: string; n: string; status: string }>(
      `select external_transaction_id as ext, count(*)::text as n, min(status) as status
         from wager_transactions where external_transaction_id = any(?) group by 1 order by 1`,
      [externals],
    );
    expect(perExternal, 'cada operação aplicada exatamente uma vez').toEqual(
      [...externals].sort().map((ext) => ({ ext, n: '1', status: 'PROCESSED' })),
    );
    const dupEntries = await rows('select transaction_id from wallet_ledger_entries group by transaction_id having count(*) > 1');
    expect(dupEntries, 'no máximo um lançamento por transação').toEqual([]);
    for (const wallet of wallets) {
      const [row] = await rows<{ balance: string }>('select balance::text as balance from wallets where id = ?', [wallet.id]);
      expect(row?.balance, `saldo esperado de ${wallet.id}`).toBe(cents(wallet.expected));
    }
    // Nenhum evento confirmado perdido: todo eventId desta fase chegou à fila de eventos.
    const outboxIds = (await rows<{ id: string }>('select id from outbox_messages where seq > ?', [fromSeq])).map((r) => r.id);
    const delivered = new Set((await drain(sqs, events.url)).map((m) => m.body.eventId as string));
    expect(outboxIds.filter((id) => !delivered.has(id)), 'eventos confirmados não publicados').toEqual([]);
    for (const wallet of wallets) {
      const response = await callWithRetry(instances, pick++, 'POST', `/wallets/${wallet.id}/reconciliation`);
      expect(response.body['consistent'], `reconciliação de ${wallet.id}`).toBe(true);
    }
  }

  const maxSeq = async () => Number((await rows<{ seq: string }>('select coalesce(max(seq), 0)::text as seq from outbox_messages'))[0]?.seq);

  beforeAll(async () => {
    orm = await openOrm();
    await truncateAll(orm);
    sqs = createSqsClient(loadConfig());
    queues = await createQueues(sqs);
    events = await createEventsQueue(sqs);
    for (const label of ['A', 'B']) instances.push(new Instance(label, await freePort(), env()));
    instances.forEach((instance) => instance.start());
    await waitReady();
    for (let i = 0; i < 4; i++) {
      const playerId = `player-chaos-${i}`;
      const response = await callWithRetry(instances, pick++, 'POST', '/wallets', {
        body: { playerId, initialBalance: { amount: '1000.00', currency: 'BRL' } },
      });
      expect(response.status).toBe(201);
      wallets.push({ id: response.body['id'] as string, playerId, expected: 100_000n });
    }
  }, 120_000);

  afterAll(async () => {
    // Nunca deixa o ambiente derrubado, mesmo se o teste falhar no meio.
    if (down.has('localstack-paused')) await compose('unpause', 'localstack').catch(() => undefined);
    if (down.has('postgres-stopped')) await compose('start', 'postgres').catch(() => undefined);
    await compose('up', '-d', '--wait', 'postgres', 'localstack').catch(() => undefined);
    await Promise.all(instances.map((instance) => instance.kill()));
    await Promise.allSettled([deleteQueues(sqs, queues), deleteQueue(sqs, events.url)]);
    await orm.close(true);
    sqs.destroy();
  }, 120_000);

  it('Postgres fora do ar durante a carga: API 503, consumidor em retry sem DLQ, tudo retoma e fica consistente', async () => {
    const fromSeq = await maxSeq();
    const retriesBefore = await metric('wagering_retries_total');
    const externals: string[] = [];
    // Pendente antes da queda: o ROLLBACK chega antes; a BET referenciada chega pela fila na queda.
    const [w0] = wallets as [Wallet];
    expect((await submitWithRetry(payload(w0, 'rb-pg-1', 'ROLLBACK', { referenceExternalTransactionId: 'bet-pg-1' }))).status).toBe(202);
    externals.push('rb-pg-1', 'bet-pg-1');

    await compose('stop', 'postgres');
    down.add('postgres-stopped');
    const stoppedAt = Date.now();
    const duringOutage: Array<{ ext: string; status: number; retryAfter: string | null; body: string }> = [];
    let readyDown = 0;
    await submitSqs(payload(w0, 'bet-pg-1'));
    for (let i = 0; Date.now() - stoppedAt < PG_OUTAGE_MS; i++) {
      const wallet = wallets[i % wallets.length]!;
      const http = `pg-http-${i}`;
      duringOutage.push({ ext: http, ...(await submitOnce(payload(wallet, http))) });
      const viaSqs = `pg-sqs-${i}`;
      await submitSqs(payload(wallet, viaSqs));
      wallet.expected -= 2n * BET;
      externals.push(http, viaSqs);
      for (const instance of instances) {
        if ((await fetch(`${instance.url}/health/ready`)).status === 503) readyDown++;
      }
      await Bun.sleep(500); // ritmo da carga, não sincronização
    }
    expect(duringOutage.length).toBeGreaterThan(0);
    expect(
      duringOutage.filter((r) => r.status !== 503 || r.retryAfter === null),
      'toda submissão com o banco fora volta 503 com Retry-After',
    ).toEqual([]);
    expect(readyDown, '/health/ready acusou o banco fora').toBeGreaterThan(0);

    const outageMs = Date.now() - stoppedAt;
    await compose('start', 'postgres');
    await compose('up', '-d', '--wait', 'postgres');
    down.delete('postgres-stopped');
    await waitReady();
    // O provedor reenvia as que receberam 503 (mesma key): aplicadas uma vez.
    for (const { ext } of duringOutage) {
      const wallet = wallets[Number(ext.split('-').at(-1)) % wallets.length]!;
      expect((await submitWithRetry(payload(wallet, ext))).status).toBe(200);
    }
    await quiescent();

    expect((await metric('wagering_retries_total')) - retriesBefore, 'o consumidor fez retry durante a queda').toBeGreaterThan(0);
    // Os consumidores entraram no modo "banco fora" e saíram dele; nenhum mandou mensagem para a DLQ.
    const total = (event: string) => instances.reduce((sum, instance) => sum + instance.count(event), 0);
    expect(total('sqs_consumer_db_unavailable'), 'entrou no modo "banco fora"').toBeGreaterThan(0);
    expect(total('sqs_consumer_db_available'), 'saiu do modo a cada entrada').toBe(total('sqs_consumer_db_unavailable'));
    expect(total('sqs_message_dead_lettered'), 'nenhuma mensagem na DLQ').toBe(0);
    expect(await metric('wagering_consumer_db_unavailable'), 'gauge de volta a 0').toBe(0);
    await expectConsistent(fromSeq, externals);
    const downMs = instances.flatMap((instance) =>
      [...instance.logTail(4_000).matchAll(/"event":"sqs_consumer_db_available","downMs":(\d+)/g)].map((m) => Number(m[1])),
    );
    report('postgres', {
      paradoMs: outageMs,
      httpNaQueda: duringOutage.length,
      httpNaQueda503ComRetryAfter: duringOutage.filter((r) => r.status === 503 && r.retryAfter !== null).length,
      readyDown503: readyDown,
      mensagensSqsNaQueda: externals.filter((ext) => ext.startsWith('pg-sqs-') || ext === 'bet-pg-1').length,
      entradasModoBancoFora: total('sqs_consumer_db_unavailable'),
      saidasModoBancoFora: total('sqs_consumer_db_available'),
      downMsPorSaida: downMs,
      retriesConsumidor: (await metric('wagering_retries_total')) - retriesBefore,
      dlq: (await readDlq(sqs, queues.dlqUrl)).length,
      operacoesConferidasUmaVez: externals.length,
    });
  }, 300_000);

  it('SQS fora do ar: eventos confirmados ficam na outbox até publicar; consumidor e publisher retomam sem perder nada', async () => {
    const fromSeq = await maxSeq();
    const failuresBefore = await metric('wagering_outbox_publish_failures_total');
    const externals: string[] = [];
    // Mensagens já na fila no momento da queda.
    for (let i = 0; i < 8; i++) {
      const wallet = wallets[i % wallets.length]!;
      const ext = `sqs-queued-${i}`;
      await submitSqs(payload(wallet, ext));
      wallet.expected -= BET;
      externals.push(ext);
    }

    await compose('pause', 'localstack');
    down.add('localstack-paused');
    const pausedAt = Date.now();
    const committed: string[] = [];
    for (let i = 0; Date.now() - pausedAt < SQS_OUTAGE_MS; i++) {
      const wallet = wallets[i % wallets.length]!;
      const ext = `sqs-down-http-${i}`;
      // A API não depende do SQS: a transação financeira é confirmada normalmente.
      expect((await submitWithRetry(payload(wallet, ext))).status).toBe(200);
      wallet.expected -= BET;
      externals.push(ext);
      committed.push(ext);
      await Bun.sleep(500); // ritmo da carga, não sincronização
    }
    // Com o SQS fora, os eventos dessas transações estão confirmados na outbox e não publicados.
    const [held] = await rows<{ total: string; unpublished: string }>(
      `select count(*)::text as total, count(*) filter (where o.published_at is null)::text as unpublished
         from outbox_messages o join wager_transactions t on t.id::text = o.payload->'data'->>'transactionId'
        where t.external_transaction_id = any(?)`,
      [committed],
    );
    expect(Number(held?.total), 'eventos das transações confirmadas na queda').toBe(committed.length * 2);
    expect(held?.unpublished, 'nenhum publicado com o SQS fora').toBe(held?.total);

    await compose('unpause', 'localstack');
    down.delete('localstack-paused');
    await waitReady();
    await quiescent();

    const publishFailures = (await metric('wagering_outbox_publish_failures_total')) - failuresBefore;
    expect(publishFailures, 'o publisher falhou e reagendou').toBeGreaterThan(0);
    await expectConsistent(fromSeq, externals);
    report('localstack', {
      pausadoMs: SQS_OUTAGE_MS,
      mensagensNaFilaAntes: 8,
      transacoesHttpConfirmadasNaQueda: committed.length,
      eventosRetidosNaOutbox: Number(held?.unpublished),
      falhasDePublicacao: publishFailures,
      dlq: (await readDlq(sqs, queues.dlqUrl)).length,
      operacoesConferidasUmaVez: externals.length,
    });
  }, 240_000);
});
