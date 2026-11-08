import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { SQSClient } from '@aws-sdk/client-sqs';
import type { MikroORM } from '@mikro-orm/postgresql';
import { loadConfig } from '../../src/infrastructure/config/app-config';
import { openOrm, truncateAll } from '../integration/persistence/db';
import { createQueues, deleteQueues, queueDepth, send, type TestQueues } from '../integration/interfaces/sqs-harness';
import { createEventsQueue, deleteQueue, drain } from '../integration/workers/outbox-harness';
import { expectConsistent, waitQuiescence } from './consistency';
import { callWithRetry, cents, eventually, freePort, Instance, prng, seedFromEnv, type HttpResult } from './harness';

/**
 * Teste multi-instância (CHALLENGE §13: concorrência 4, 5 e 8).
 *
 * Três processos reais da aplicação (API + consumidor SQS + outbox publisher + worker de
 * pendentes) sobre o mesmo Postgres e o mesmo LocalStack, com carga mista e determinística
 * (seed fixa, `MULTI_SEED` para reproduzir), SIGKILL no ponto "depois do commit, antes do ack"
 * e SIGKILL de todas as instâncias no meio da carga. Todas as verificações finais são SQL
 * direto no banco. Estratégia e limitações: ARCHITECTURE.md → "Estratégia de testes".
 */

const SEED = seedFromEnv(process.env['MULTI_SEED'], 20261107);
const PENDING_TTL_MS = 25_000;
const PROVIDER = 'provider-a';

interface TestWallet {
  id: string;
  playerId: string;
  label: string;
  start: bigint;
  /** Saldo final esperado, calculado só pelo teste (independente do sistema). */
  expected: bigint;
}

type Payload = Record<string, unknown>;

describe(`multi-instância: 3 processos reais, SIGKILL e carga mista (seed ${SEED})`, () => {
  let orm: MikroORM;
  let sqs: SQSClient;
  let queues: TestQueues;
  let events: { name: string; url: string };
  const instances: Instance[] = [];
  /** Todas as instâncias já criadas (inclusive a F, que sai de `instances`): cauda de log na falha. */
  const everyInstance: Instance[] = [];
  const wallets: TestWallet[] = [];
  const rand = prng(SEED);
  let step = 'setup';

  const knex = () => orm.em.getKnex();
  async function rows<T>(sql: string, bindings: string[] = []): Promise<T[]> {
    return (await knex().raw<{ rows: T[] }>(sql, bindings)).rows;
  }

  function instanceEnv(extra: Record<string, string> = {}): Record<string, string> {
    return {
      NODE_ENV: 'test',
      SQS_CONSUMER_ENABLED: 'true',
      OUTBOX_PUBLISHER_ENABLED: 'true',
      PENDING_REFERENCE_WORKER_ENABLED: 'true',
      SQS_WAGER_QUEUE_NAME: queues.queueName,
      SQS_WAGER_DLQ_NAME: queues.dlqName,
      SQS_WAGER_EVENTS_QUEUE_NAME: events.name,
      // Só aqui, no teste: tempos curtos para a mensagem de uma instância morta voltar logo.
      SQS_WAIT_TIME_SECONDS: '1',
      // Uma mensagem por receive: o trabalho da fila se espalha pelas 3 instâncias (o teste exige
      // que cada uma confirme mensagens, antes e depois do reinício).
      SQS_MAX_MESSAGES: '1',
      SQS_VISIBILITY_TIMEOUT_SECONDS: '6',
      SQS_RETRY_BASE_SECONDS: '1',
      SQS_RETRY_MAX_SECONDS: '2',
      SQS_SHUTDOWN_TIMEOUT_MS: '3000',
      OUTBOX_SHUTDOWN_TIMEOUT_MS: '3000',
      PENDING_REFERENCE_SHUTDOWN_TIMEOUT_MS: '3000',
      OUTBOX_POLL_INTERVAL_MS: '100',
      PENDING_REFERENCE_POLL_INTERVAL_MS: '200',
      PENDING_REFERENCE_TTL_MS: String(PENDING_TTL_MS),
      ...extra,
    };
  }

  let roundRobin = 0;
  const http = (method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<HttpResult> =>
    callWithRetry(instances, roundRobin++, method, path, { ...(body === undefined ? {} : { body }), headers });

  async function openWallet(label: string, start: bigint, via: Instance[] = instances): Promise<TestWallet> {
    const playerId = `player-${label}`;
    const response = await callWithRetry(via, roundRobin++, 'POST', '/wallets', {
      body: { playerId, initialBalance: { amount: cents(start), currency: 'BRL' } },
    });
    // POST /wallets não tem Idempotency-Key: se a 1ª tentativa commitou e a resposta se perdeu, o
    // reenvio do cliente recebe 409 com o id da wallet já criada (ARCHITECTURE.md → "API HTTP").
    const retriedConflict = response.status === 409 && response.attempts > 1 && typeof response.body['error']?.['walletId'] === 'string';
    expect(response.status === 201 || retriedConflict, `POST /wallets ${label}: ${response.status} ${JSON.stringify(response.body)}`).toBe(true);
    const id = (retriedConflict ? response.body['error']['walletId'] : response.body['id']) as string;
    const wallet = { id, playerId, label, start, expected: start };
    wallets.push(wallet);
    return wallet;
  }

  function payload(wallet: TestWallet, externalTransactionId: string, kind: string, amount: bigint, extra: Payload = {}): Payload {
    return {
      providerId: PROVIDER,
      externalTransactionId,
      playerId: wallet.playerId,
      walletId: wallet.id,
      roundId: `round-${externalTransactionId}`,
      gameId: 'game-1',
      kind,
      money: { amount: cents(amount), currency: 'BRL' },
      ...extra,
    };
  }

  const submitHttp = (data: Payload, via?: Instance[]): Promise<HttpResult> =>
    callWithRetry(via ?? instances, roundRobin++, 'POST', '/wagering/transactions', {
      body: data,
      headers: { 'idempotency-key': `${PROVIDER}:${data['externalTransactionId'] as string}` },
    });

  /**
   * Produtor SQS: grupo = walletId (ou `groupId`, para entregas paralelas da mesma transação);
   * dedup do broker = `dedupId` (distinto para forçar duplicatas reais).
   */
  const submitSqs = (data: Payload, messageId: string, dedupId: string = messageId, groupId?: string): Promise<void> =>
    send(
      sqs,
      queues.queueUrl,
      {
        messageId,
        type: 'WagerTransactionRequested',
        occurredAt: new Date().toISOString(),
        data: { ...data, idempotencyKey: `${PROVIDER}:${data['externalTransactionId'] as string}` },
      },
      { dedupId, ...(groupId === undefined ? {} : { groupId }) },
    );

  async function balanceOf(wallet: TestWallet): Promise<string> {
    const [row] = await rows<{ balance: string }>('select balance::text as balance from wallets where id = ?', [wallet.id]);
    return row?.balance ?? 'ausente';
  }

  beforeAll(async () => {
    const config = loadConfig();
    sqs = new SQSClient({
      region: config.aws.region,
      ...(config.aws.endpointUrl ? { endpoint: config.aws.endpointUrl } : {}),
      ...(config.aws.accessKeyId && config.aws.secretAccessKey
        ? { credentials: { accessKeyId: config.aws.accessKeyId, secretAccessKey: config.aws.secretAccessKey } }
        : {}),
    });
    orm = await openOrm();
    await truncateAll(orm);
    queues = await createQueues(sqs);
    events = await createEventsQueue(sqs);
  });

  afterAll(async () => {
    await Promise.all(instances.map((instance) => instance.kill()));
    await Promise.allSettled([deleteQueues(sqs, queues), deleteQueue(sqs, events.url)]);
    await orm.close(true);
    sqs.destroy();
  });

  it(
    'itens 4, 5 e 8: SIGKILL pós-commit/pré-ack, SIGKILL de todas no meio da carga, e consistência final por SQL',
    async () => {
      const startedAt = Date.now();
      const mark = (name: string): void => {
        step = name;
        console.log(`[multi seed=${SEED}] +${((Date.now() - startedAt) / 1000).toFixed(1)}s ${name}`);
      };
      try {
        // ───────────────────────── Item 5: morto depois do commit e antes do ack
        mark('item 5: instância com FAULT_INJECTION processa e morre antes do ack');
        const faulty = new Instance(
          'F',
          await freePort(),
          instanceEnv({ FAULT_INJECTION: 'exit_after_commit_before_ack', OUTBOX_PUBLISHER_ENABLED: 'false' }),
        );
        instances.push(faulty);
        everyInstance.push(faulty);
        faulty.start();
        await faulty.waitReady();

        const w5 = await openWallet('item5', 10_000n, [faulty]);
        w5.expected = 7_000n;
        await submitSqs(payload(w5, 'item5-bet-1', 'BET', 3_000n), 'm-item5-1');
        await faulty.waitExit(30_000);
        await eventually('o log do SIGKILL injetado foi lido', () => expect(faulty.count('fault_injection_sigkill')).toBe(1), 5_000, 20);
        expect(faulty.count('fault_injection_sigkill'), 'log do ponto exato do SIGKILL').toBe(1);
        // `sqs_message_acked` só é logado depois do DeleteMessage bem-sucedido: a instância morta não confirmou nada.
        expect(faulty.count('sqs_message_acked'), 'a instância morta não registrou ack').toBe(0);

        const [afterDeath] = await rows<{ tx: string; ledger: string; inbox: string; pending: string; balance: string }>(
          `select (select count(*) from wager_transactions where wallet_id = ? and kind = 'BET' and status = 'PROCESSED')::text as tx,
                  (select count(*) from wallet_ledger_entries where wallet_id = ?)::text as ledger,
                  (select count(*) from inbox_messages where message_id = 'm-item5-1')::text as inbox,
                  (select count(*) from outbox_messages where published_at is null)::text as pending,
                  (select balance::text from wallets where id = ?) as balance`,
          [w5.id, w5.id, w5.id],
        );
        expect(afterDeath, 'commit aconteceu: transação, lançamento, inbox e eventos pendentes na outbox').toEqual({
          tx: '1',
          ledger: '2', // OPENING + o débito
          inbox: '1',
          pending: '3', // WalletBalanceChanged da abertura + Processed + WalletBalanceChanged do BET (publisher desligado na F)
          balance: '70.00',
        });
        expect(await queueDepth(sqs, queues.queueUrl), 'a mensagem continua na fila (sem ack)').toBe(1);
        instances.splice(instances.indexOf(faulty), 1);

        // ───────────────────────── Item 4: três instâncias saudáveis assumem
        mark('item 4: sobe 3 instâncias saudáveis (API + consumidor + publisher + pendentes)');
        const live = await Promise.all(
          ['A', 'B', 'C'].map(async (label) => new Instance(label, await freePort(), instanceEnv())),
        );
        instances.push(...live);
        everyInstance.push(...live);
        live.forEach((instance) => instance.start());
        await Promise.all(live.map((instance) => instance.waitReady()));
        expect(new Set(live.map((instance) => instance.pid)).size, '3 PIDs distintos').toBe(3);

        mark('item 5: outra instância assume, a reentrega cai na inbox e o efeito não duplica');
        await eventually(
          'a mensagem do item 5 é reentregue e confirmada (fila vazia)',
          async () => expect(await queueDepth(sqs, queues.queueUrl)).toBe(0),
          45_000,
        );
        const duplicates = live.reduce((total, instance) => total + instance.count('sqs_message_acked:DUPLICATE_MESSAGE'), 0);
        expect(duplicates, 'reentrega reconhecida pela inbox (DUPLICATE_MESSAGE), sem chamar o use case').toBe(1);
        const [afterRedelivery] = await rows<{ ledger: string; txs: string; inbox: string }>(
          `select (select count(*) from wallet_ledger_entries where wallet_id = ?)::text as ledger,
                  (select count(*) from wager_transactions where wallet_id = ? and kind = 'BET')::text as txs,
                  (select count(*) from inbox_messages where message_id = 'm-item5-1')::text as inbox`,
          [w5.id, w5.id],
        );
        expect(afterRedelivery, 'um débito, uma transação, uma inbox').toEqual({ ledger: '2', txs: '1', inbox: '1' });

        // ───────────────────────── Carga da onda 1 (HTTP + SQS, 3 instâncias)
        mark('onda 1: wallets');
        const scenario = await openWallet('scenario', 10_000n);
        const hot = await openWallet('hot', 100_000n);
        const dupHttp = await openWallet('dup-http', 20_000n);
        const dupSqs = await openWallet('dup-sqs', 20_000n);
        const randoms: TestWallet[] = [];
        for (let i = 1; i <= 12; i++) {
          const start = BigInt(20_000 + Math.floor(rand() * 80_000));
          randoms.push(await openWallet(`rnd-${i}`, start));
        }

        mark('cenário obrigatório: 80.00 + 80.00 sobre 100.00, duas instâncias, em paralelo');
        const pair = await Promise.all([
          submitHttp(payload(scenario, 'scn-bet-1', 'BET', 8_000n), [live[0]!]),
          submitHttp(payload(scenario, 'scn-bet-2', 'BET', 8_000n), [live[1]!]),
        ]);
        scenario.expected = 2_000n;
        expect(pair.map((r) => r.status).sort(), 'uma 200 (PROCESSED) e uma 422 (REJECTED)').toEqual([200, 422]);
        expect(pair.find((r) => r.status === 422)?.body['failureCode']).toBe('INSUFFICIENT_BALANCE');

        // Item 1 entre instâncias e canais: a MESMA aposta (mesma Idempotency-Key) 50x em paralelo,
        // 30 por HTTP (10 em cada instância) e 20 por SQS (messageIds e grupos distintos, para as
        // entregas correrem em paralelo nas 3 instâncias). Resultado: 1 transação e 1 débito.
        mark('item 1: mesma aposta 50x em paralelo (30 HTTP nas 3 instâncias + 20 SQS)');
        dupHttp.expected = 16_000n;
        const dupPayload = payload(dupHttp, 'dup50-bet-1', 'BET', 4_000n);
        const dupMessageIds = Array.from({ length: 20 }, (_, i) => `m-dup50-${i + 1}`);
        const [dupResponses] = await Promise.all([
          Promise.all(Array.from({ length: 30 }, (_, i) => submitHttp(dupPayload, [live[i % 3]!]))),
          Promise.all(dupMessageIds.map((id) => submitSqs(dupPayload, id, id, `dup50-${id}`))),
        ]);
        expect(dupResponses.map((r) => r.status).filter((s) => s !== 200), 'todas as respostas HTTP são 200').toEqual([]);
        expect(new Set(dupResponses.map((r) => r.body['transactionId'])).size, 'um único transactionId no HTTP').toBe(1);
        expect(dupResponses.filter((r) => r.body['idempotentReplay'] === false).length, 'no máximo uma execução original pelo HTTP').toBeLessThanOrEqual(1);
        await eventually(
          'as 20 mensagens SQS da aposta duplicada foram confirmadas (inbox)',
          async () => {
            const [row] = await rows<{ n: string }>(`select count(*)::text as n from inbox_messages where message_id like 'm-dup50-%'`);
            expect(row?.n).toBe('20');
          },
          45_000,
        );
        const [dup50] = await rows<{ txs: string; debits: string; tx_id: string; balance: string }>(
          `select (select count(*) from wager_transactions where wallet_id = ? and kind = 'BET')::text as txs,
                  (select count(*) from wallet_ledger_entries where wallet_id = ? and direction = 'DEBIT')::text as debits,
                  (select id from wager_transactions where wallet_id = ? and kind = 'BET') as tx_id,
                  (select balance::text from wallets where id = ?) as balance`,
          [dupHttp.id, dupHttp.id, dupHttp.id, dupHttp.id],
        );
        expect(dup50, '50 envios: uma transação, um débito, saldo 160.00').toEqual({
          txs: '1',
          debits: '1',
          tx_id: dupResponses[0]?.body['transactionId'],
          balance: '160.00',
        });

        // Antes do kill: cada uma das 3 instâncias atendeu HTTP e confirmou mensagens SQS.
        for (const instance of live) {
          expect(instance.count('wager_transaction_processed@http'), `${instance.label} atendeu HTTP antes do kill`).toBeGreaterThan(0);
          expect(instance.count('sqs_message_acked'), `${instance.label} confirmou mensagens SQS antes do kill`).toBeGreaterThan(0);
        }

        mark('onda 1: dispara HTTP e SQS juntos (hot wallet, duplicatas SQS, wallets aleatórias)');
        const pendingHttp: Array<Promise<{ op: string; result: HttpResult }>> = [];
        const sqsSends: Array<Promise<void>> = [];
        const sqsOrHttp = (op: string, data: Payload, viaSqs: boolean, messageId: string): void => {
          if (viaSqs) sqsSends.push(submitSqs(data, messageId));
          else pendingHttp.push(submitHttp(data).then((result) => ({ op, result })));
        };

        // Hot wallet: 120 BETs de 10.00 sobre 1000.00 → exatamente 100 processadas e 20 rejeitadas.
        hot.expected = 0n;
        for (let i = 1; i <= 120; i++) {
          sqsOrHttp(`hot-${i}`, payload(hot, `hot-bet-${i}`, 'BET', 1_000n), i % 2 === 0, `m-hot-${i}`);
        }

        // Duplicatas SQS: o mesmo messageId 3x (dedup do broker distintos) e outra mensagem com a mesma key 2x.
        dupSqs.expected = 17_000n;
        const dupSqsPayload = payload(dupSqs, 'dup-sqs-bet-1', 'BET', 3_000n);
        for (const suffix of ['a', 'b', 'c']) sqsSends.push(submitSqs(dupSqsPayload, 'm-dup-sqs-1', `m-dup-sqs-1#${suffix}`));
        sqsSends.push(submitSqs(dupSqsPayload, 'm-dup-sqs-2'));
        sqsSends.push(submitSqs(dupSqsPayload, 'm-dup-sqs-3'));

        // Wallets aleatórias: 6 BETs que cabem no saldo, 2 acima do saldo, 1 WIN e 1 LOSS. O resultado
        // não depende da ordem: o saldo máximo possível é start + 7.00 < start + 20.00 (apostas grandes).
        for (const wallet of randoms) {
          const slice = Number(wallet.start) / 6;
          let spent = 0n;
          for (let i = 1; i <= 6; i++) {
            const amount = BigInt(100 + Math.floor(rand() * (slice - 100)));
            spent += amount;
            sqsOrHttp(`${wallet.label}-bet-${i}`, payload(wallet, `${wallet.label}-bet-${i}`, 'BET', amount), rand() < 0.5, `m-${wallet.label}-bet-${i}`);
          }
          for (let i = 1; i <= 2; i++) {
            const amount = wallet.start + 2_000n;
            sqsOrHttp(`${wallet.label}-big-${i}`, payload(wallet, `${wallet.label}-big-${i}`, 'BET', amount), rand() < 0.5, `m-${wallet.label}-big-${i}`);
          }
          sqsOrHttp(`${wallet.label}-win`, payload(wallet, `${wallet.label}-win`, 'WIN', 700n), rand() < 0.5, `m-${wallet.label}-win`);
          sqsOrHttp(`${wallet.label}-loss`, payload(wallet, `${wallet.label}-loss`, 'LOSS', 500n), rand() < 0.5, `m-${wallet.label}-loss`);
          wallet.expected = wallet.start - spent + 700n;
        }
        await Promise.all(sqsSends);

        // ───────────────────────── Item 8: SIGKILL de todas as instâncias no meio da carga
        mark('item 8: SIGKILL das 3 instâncias no meio da carga');
        await eventually(
          'o consumo começou (há mensagens na inbox)',
          async () => {
            // Só mensagens da onda 1 (as do item 5 e do item 1 já estão na inbox).
            const [row] = await rows<{ n: string }>(
              `select count(*)::text as n from inbox_messages where message_id <> 'm-item5-1' and message_id not like 'm-dup50-%'`,
            );
            expect(Number(row?.n)).toBeGreaterThanOrEqual(5);
          },
          30_000,
          5,
        );
        const [midLoad] = await rows<{ inbox: string; outbox: string }>(
          `select (select count(*) from inbox_messages)::text as inbox,
                  (select count(*) from outbox_messages where published_at is null)::text as outbox`,
        );
        const depthAtKill = await queueDepth(sqs, queues.queueUrl);
        await Promise.all(live.map((instance) => instance.kill()));
        console.log(
          `[multi seed=${SEED}] morte no meio da carga: inbox=${midLoad?.inbox}, outbox pendente=${midLoad?.outbox}, fila=${depthAtKill}`,
        );
        expect(
          depthAtKill > 0 || Number(midLoad?.outbox) > 0,
          'o SIGKILL pegou trabalho em andamento (fila ou outbox não vazias)',
        ).toBe(true);
        expect(live.every((instance) => !instance.running)).toBe(true);

        // ───────────────────────── Reinício
        mark('item 8: sobe de novo as 3 instâncias (mesmas portas)');
        live.forEach((instance) => instance.start());
        await Promise.all(live.map((instance) => instance.waitReady()));

        // HTTP que estava em voo na queda foi reenviado pelo cliente (mesma key) e termina aqui.
        const httpResults = await Promise.all(pendingHttp);
        const unexpected = httpResults.filter(({ result }) => ![200, 202, 422].includes(result.status));
        expect(unexpected, 'toda resposta HTTP final é 200, 202 ou 422').toEqual([]);

        // ───────────────────────── Onda 2: reversões antes da referência, órfã e replays
        mark('onda 2: REFUND/ROLLBACK antes da referência (HTTP e SQS), referência que nunca chega');
        const reversalWallets: TestWallet[] = [];
        for (let i = 1; i <= 6; i++) reversalWallets.push(await openWallet(`rev-${i}`, 50_000n));
        for (const [index, wallet] of reversalWallets.entries()) {
          const viaSqs = index % 2 === 1;
          const kind = index < 4 ? 'REFUND' : 'ROLLBACK';
          const betId = `${wallet.label}-bet`;
          const roundId = `round-${wallet.label}`;
          const reversal = payload(wallet, `${wallet.label}-${kind.toLowerCase()}`, kind, 2_500n, {
            roundId,
            referenceExternalTransactionId: betId,
          });
          const bet = payload(wallet, betId, 'BET', 2_500n, { roundId });
          if (viaSqs) {
            await submitSqs(reversal, `m-${wallet.label}-reversal`);
            await submitSqs(bet, `m-${wallet.label}-bet`);
          } else {
            const first = await submitHttp(reversal);
            expect(first.status, `${kind} antes da BET devolve 202 (PENDING_REFERENCE)`).toBe(202);
            expect((await submitHttp(bet)).status).toBe(200);
          }
          wallet.expected = 50_000n; // BET −25.00 e reversão +25.00
        }

        const orphan = await openWallet('orphan', 10_000n);
        const orphanResponse = await submitHttp(
          payload(orphan, 'orphan-refund', 'REFUND', 1_000n, { referenceExternalTransactionId: 'nunca-chega' }),
        );
        expect(orphanResponse.status).toBe(202);

        mark('onda 2: replays de transações da onda 1 enviados a cada instância');
        const replayable = httpResults.filter(({ op, result }) => op.startsWith('hot-') && result.status === 200).slice(0, 3);
        expect(replayable.length, 'há transações HTTP da hot wallet para reenviar').toBeGreaterThan(0);
        for (const [index, { op, result }] of replayable.entries()) {
          const number = op.split('-')[1];
          const replays = await Promise.all(
            live.map((instance) => submitHttp(payload(hot, `hot-bet-${number}`, 'BET', 1_000n), [instance])),
          );
          for (const replay of replays) {
            expect(replay.status, `replay #${index} da ${op}`).toBe(200);
            expect(replay.body['transactionId']).toBe(result.body['transactionId']);
            expect(replay.body['idempotentReplay']).toBe(true);
          }
        }

        // ───────────────────────── Quiescência
        mark('quiescência (a órfã expira pelo TTL de 25s)');
        await waitQuiescence(rows, sqs, queues.queueUrl);

        // Depois do reinício (contadores zerados no start): cada instância atendeu HTTP e confirmou SQS.
        for (const instance of live) {
          expect(instance.count('wager_transaction_processed@http'), `${instance.label} atendeu HTTP depois do reinício`).toBeGreaterThan(0);
          expect(instance.count('sqs_message_acked'), `${instance.label} confirmou mensagens SQS depois do reinício`).toBeGreaterThan(0);
        }

        // ───────────────────────── Verificações finais, todas por SQL
        mark('verificações finais por SQL');

        // 1–7. Invariantes de todo o banco (test/multi/consistency.ts, compartilhadas com o test:load).
        const delivered = await drain(sqs, events.url, 5);
        const deliveredIds = new Set(delivered.map((event) => event.body['eventId'] as string));
        const { outboxEvents } = await expectConsistent(rows, {
          deliveredEventIds: deliveredIds,
          dlqDepth: await queueDepth(sqs, queues.dlqUrl),
        });
        console.log(
          `[multi seed=${SEED}] eventos: outbox=${outboxEvents}, mensagens na fila=${delivered.length} (duplicatas: ${delivered.length - deliveredIds.size})`,
        );

        // 8. Reconciliação por HTTP consistente para todas as wallets, em instâncias diferentes.
        const reconciliations = await Promise.all(
          wallets.map((wallet) => http('POST', `/wallets/${wallet.id}/reconciliation`)),
        );
        for (const [index, response] of reconciliations.entries()) {
          expect(response.status, `reconciliação ${wallets[index]?.label}`).toBe(200);
          expect(response.body['consistent'], `reconciliação ${wallets[index]?.label}: ${JSON.stringify(response.body)}`).toBe(true);
        }

        // 9. Resultado esperado, calculado de forma independente, para um conjunto conhecido de wallets.
        for (const wallet of wallets) {
          expect(await balanceOf(wallet), `saldo final de ${wallet.label}`).toBe(cents(wallet.expected));
        }
        const [hotCounts] = await rows<{ processed: string; rejected: string }>(
          `select count(*) filter (where status = 'PROCESSED')::text as processed,
                  count(*) filter (where status = 'REJECTED' and failure_code = 'INSUFFICIENT_BALANCE')::text as rejected
             from wager_transactions where wallet_id = ? and kind = 'BET'`,
          [hot.id],
        );
        expect(hotCounts, 'hot wallet: 120 BETs de 10.00 sobre 1000.00').toEqual({ processed: '100', rejected: '20' });
        const [scenarioCounts] = await rows<{ debits: string; processed: string; rejected: string }>(
          `select (select count(*) from wallet_ledger_entries where wallet_id = ? and direction = 'DEBIT')::text as debits,
                  count(*) filter (where status = 'PROCESSED')::text as processed,
                  count(*) filter (where status = 'REJECTED')::text as rejected
             from wager_transactions where wallet_id = ? and kind = 'BET'`,
          [scenario.id, scenario.id],
        );
        expect(scenarioCounts, 'cenário 80 + 80: um débito, uma PROCESSED, uma REJECTED').toEqual({ debits: '1', processed: '1', rejected: '1' });
        for (const wallet of randoms) {
          const [counts] = await rows<{ rejected: string; processed: string }>(
            `select count(*) filter (where status = 'REJECTED' and failure_code = 'INSUFFICIENT_BALANCE')::text as rejected,
                    count(*) filter (where status = 'PROCESSED')::text as processed
               from wager_transactions where wallet_id = ? and kind = 'BET'`,
            [wallet.id],
          );
          expect(counts, `${wallet.label}: 6 BETs aceitas e 2 acima do saldo rejeitadas`).toEqual({ rejected: '2', processed: '6' });
        }
        for (const wallet of reversalWallets) {
          const finalStates = await rows<{ kind: string; status: string }>(
            `select kind, status from wager_transactions where wallet_id = ? and kind <> 'OPENING' order by kind`,
            [wallet.id],
          );
          expect(finalStates.map((s) => s.status), `${wallet.label}: BET e reversão PROCESSED`).toEqual(['PROCESSED', 'PROCESSED']);
        }
        const [orphanState] = await rows<{ status: string; failure_code: string }>(
          `select status, failure_code from wager_transactions where wallet_id = ? and kind = 'REFUND'`,
          [orphan.id],
        );
        expect(orphanState, 'referência que nunca chegou: REJECTED REFERENCE_NOT_FOUND').toEqual({
          status: 'REJECTED',
          failure_code: 'REFERENCE_NOT_FOUND',
        });
        // Em eventos de transação, aggregate_id é o id da TRANSAÇÃO (o da wallet é só nos WalletBalanceChanged).
        const [orphanEvent] = await rows<{ n: string }>(
          `select count(*)::text as n from outbox_messages
            where event_type = 'WagerTransactionRejected'
              and aggregate_id = (select id from wager_transactions where wallet_id = ? and kind = 'REFUND')`,
          [orphan.id],
        );
        expect(orphanEvent?.n, 'evento WagerTransactionRejected da órfã').toBe('1');
        const [dupSqsCounts] = await rows<{ txs: string; ledger: string }>(
          `select (select count(*) from wager_transactions where wallet_id = ? and kind = 'BET')::text as txs,
                  (select count(*) from wallet_ledger_entries where wallet_id = ? and direction = 'DEBIT')::text as ledger`,
          [dupSqs.id, dupSqs.id],
        );
        expect(dupSqsCounts, 'duplicatas SQS: uma transação e um débito').toEqual({ txs: '1', ledger: '1' });

        // Evidência de que as 3 instâncias de fato atenderam tráfego (e a carga não foi de uma só).
        const served = live.map((instance) => ({
          label: instance.label,
          http: instance.count('wager_transaction_processed@http'),
          sqsAcked: instance.count('sqs_message_acked'),
        }));
        console.log(`[multi seed=${SEED}] tráfego por instância depois do reinício: ${JSON.stringify(served)}`);
        mark('concluído');
      } catch (error) {
        console.error(`\n[multi] FALHOU no passo "${step}". Reproduza com: MULTI_SEED=${SEED} bun run test:multi`);
        for (const instance of everyInstance) console.error(instance.logTail(12));
        throw error;
      }
    },
    300_000,
  );
});
