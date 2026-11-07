import 'reflect-metadata';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import type { INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { MikroORM } from '@mikro-orm/postgresql';
import { AppModule } from '../../../src/app.module';
import { loadConfig } from '../../../src/infrastructure/config/app-config';
import { openOrm, truncateAll } from '../persistence/db';

type Json = Record<string, any>;

describe('API HTTP de wagering (Postgres real)', () => {
  let app: INestApplication;
  let orm: MikroORM;
  let url: string;
  const knex = () => orm.em.getKnex();

  beforeAll(async () => {
    orm = await openOrm();
    app = await NestFactory.create(AppModule.register(loadConfig()), { logger: false });
    await app.listen(0);
    const address = app.getHttpServer().address() as { port: number };
    url = `http://127.0.0.1:${address.port}`;
  });

  beforeEach(async () => truncateAll(orm));

  afterAll(async () => {
    await app.close();
    await orm.close();
  });

  async function call(method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
    const response = await fetch(`${url}${path}`, {
      method,
      headers: { 'content-type': 'application/json', ...headers },
      ...(body === undefined ? {} : { body: typeof body === 'string' ? body : JSON.stringify(body) }),
    });
    const text = await response.text();
    return { status: response.status, headers: response.headers, body: (text ? JSON.parse(text) : {}) as Json };
  }

  async function openWallet(playerId = 'player-1', amount = '100.00', headers: Record<string, string> = {}) {
    const response = await call('POST', '/wallets', { playerId, initialBalance: { amount, currency: 'BRL' } }, headers);
    expect(response.status).toBe(201);
    return response.body as { id: string; playerId: string };
  }

  function wager(wallet: { id: string; playerId: string }, externalTransactionId: string, extra: Json = {}): Json {
    return {
      providerId: 'provider-a',
      externalTransactionId,
      playerId: wallet.playerId,
      walletId: wallet.id,
      roundId: 'round-1',
      gameId: 'game-1',
      kind: 'BET',
      money: { amount: '10.00', currency: 'BRL' },
      ...extra,
    };
  }

  const submit = (payload: Json, key = `provider-a:${payload.externalTransactionId}`, headers: Record<string, string> = {}) =>
    call('POST', '/wagering/transactions', payload, { 'idempotency-key': key, ...headers });

  const metricsText = async () => (await fetch(`${url}/metrics`)).text();

  describe('POST /wallets', () => {
    it('grava wallet, OPENING, CREDIT e WalletBalanceChanged na mesma transação, com version 1', async () => {
      const response = await call('POST', '/wallets', { playerId: 'p1', initialBalance: { amount: '100.00', currency: 'BRL' } }, { 'x-correlation-id': 'corr-open' });
      expect(response.status).toBe(201);
      expect(response.body).toEqual({ id: expect.any(String), playerId: 'p1', balance: { amount: '100.00', currency: 'BRL' }, version: 1 });
      const id = response.body.id as string;

      const [opening] = await knex()('wager_transactions').where({ wallet_id: id });
      expect(opening).toMatchObject({ kind: 'OPENING', status: 'PROCESSED', provider_id: 'internal', amount: '100.00' });
      const entries = await knex()('wallet_ledger_entries').where({ wallet_id: id });
      expect(entries).toHaveLength(1);
      expect(entries[0]).toMatchObject({ direction: 'CREDIT', transaction_id: opening.id, balance_before: '0.00', balance_after: '100.00' });
      const outbox = await knex()('outbox_messages').where({ aggregate_id: id });
      expect(outbox.map((row) => row.event_type)).toEqual(['WalletBalanceChanged']);
      expect(outbox[0].payload).toMatchObject({ correlationId: 'corr-open', causationId: opening.id, data: { walletVersion: 1 } });
    });

    it('saldo zero não gera OPENING, lançamento nem evento', async () => {
      const wallet = await openWallet('p-zero', '0.00');
      expect(await knex()('wager_transactions').where({ wallet_id: wallet.id })).toHaveLength(0);
      expect(await knex()('wallet_ledger_entries').where({ wallet_id: wallet.id })).toHaveLength(0);
      expect(await knex()('outbox_messages')).toHaveLength(0);
    });

    it('duplicada (mesmo player e moeda) → 409 com o id da wallet existente', async () => {
      const first = await openWallet('p-dup');
      const duplicate = await call('POST', '/wallets', { playerId: 'p-dup', initialBalance: { amount: '5.00', currency: 'BRL' } });
      expect(duplicate.status).toBe(409);
      expect(duplicate.body).toEqual({ error: { code: 'WALLET_ALREADY_EXISTS', message: expect.any(String), walletId: first.id } });
      expect(await knex()('wallets')).toHaveLength(1);
    });

    it.each([
      ['playerId ausente', { initialBalance: { amount: '1.00', currency: 'BRL' } }],
      ['playerId vazio', { playerId: '', initialBalance: { amount: '1.00', currency: 'BRL' } }],
      ['playerId só espaços', { playerId: '   ', initialBalance: { amount: '1.00', currency: 'BRL' } }],
      ['playerId longo', { playerId: 'x'.repeat(257), initialBalance: { amount: '1.00', currency: 'BRL' } }],
      ['playerId gigante (estouraria o índice)', { playerId: 'x'.repeat(5000), initialBalance: { amount: '1.00', currency: 'BRL' } }],
      ['initialBalance ausente', { playerId: 'p' }],
      ['amount como number', { playerId: 'p', initialBalance: { amount: 10, currency: 'BRL' } }],
      ['amount inválido', { playerId: 'p', initialBalance: { amount: 'abc', currency: 'BRL' } }],
      ['amount com 3 casas', { playerId: 'p', initialBalance: { amount: '1.001', currency: 'BRL' } }],
      ['amount negativo', { playerId: 'p', initialBalance: { amount: '-1.00', currency: 'BRL' } }],
      ['moeda inválida', { playerId: 'p', initialBalance: { amount: '1.00', currency: 'xx' } }],
    ])('%s → 400 INVALID_INPUT sem gravar nada', async (_name, body) => {
      const response = await call('POST', '/wallets', body);
      expect(response.status).toBe(400);
      expect(response.body.error.code).toBe('INVALID_INPUT');
      expect(response.body.error.message).not.toMatch(/violates|relation|syntax|index row/i);
      expect(await knex()('wallets')).toHaveLength(0);
    });
  });

  describe('POST /wagering/transactions', () => {
    it('Idempotency-Key ausente ou vazio → 400', async () => {
      const wallet = await openWallet();
      expect((await call('POST', '/wagering/transactions', wager(wallet, 'e1'))).status).toBe(400);
      const blank = await call('POST', '/wagering/transactions', wager(wallet, 'e1'), { 'idempotency-key': '   ' });
      expect(blank.status).toBe(400);
      expect(blank.body.error.code).toBe('INVALID_INPUT');
    });

    it('OPENING enviado → 400', async () => {
      const wallet = await openWallet();
      const response = await submit(wager(wallet, 'e-open', { kind: 'OPENING' }));
      expect(response.status).toBe(400);
      expect(response.body.error.code).toBe('INVALID_INPUT');
    });

    it('providerId "internal" e Idempotency-Key "opening:" são reservados → 400', async () => {
      const wallet = await openWallet();
      const internal = await submit(wager(wallet, `opening:${wallet.id}`, { providerId: 'internal' }), `opening:${wallet.id}`);
      expect(internal.status).toBe(400);
      expect(internal.body.error.code).toBe('INVALID_INPUT');
      expect(internal.body.error).not.toHaveProperty('existingTransactionId');
      const prefixed = await submit(wager(wallet, 'e-r'), `opening:${wallet.id}`);
      expect(prefixed.status).toBe(400);
      const read = await call('GET', `/providers/internal/wagering/transactions/opening:${wallet.id}`);
      expect(read.status).toBe(400);
    });

    it('amount inválido → 400 sem gravar transação', async () => {
      const wallet = await openWallet();
      for (const amount of ['abc', '1e2', '10.001', 'NaN', '']) {
        const response = await submit(wager(wallet, `e-${amount}`, { money: { amount, currency: 'BRL' } }));
        expect(response.status).toBe(400);
      }
      const numeric = await submit(wager(wallet, 'e-num', { money: { amount: 10, currency: 'BRL' } }));
      expect(numeric.status).toBe(400);
      expect(await knex()('wager_transactions').whereNot({ kind: 'OPENING' })).toHaveLength(0);
    });

    it('Processed → 200; replay idêntico → mesmo status e idempotentReplay: true', async () => {
      const wallet = await openWallet();
      const first = await submit(wager(wallet, 'e-ok'));
      expect(first.status).toBe(200);
      expect(first.body).toEqual({ transactionId: expect.any(String), status: 'PROCESSED', balance: { amount: '90.00', currency: 'BRL' }, idempotentReplay: false });
      const replay = await submit(wager(wallet, 'e-ok'));
      expect(replay.status).toBe(200);
      expect(replay.body).toEqual({ ...first.body, idempotentReplay: true });
    });

    it('Rejected → 422 com failureCode; o replay também é 422', async () => {
      const wallet = await openWallet();
      const payload = wager(wallet, 'e-big', { money: { amount: '500.00', currency: 'BRL' } });
      const first = await submit(payload);
      expect(first.status).toBe(422);
      expect(first.body).toMatchObject({ status: 'REJECTED', failureCode: 'INSUFFICIENT_BALANCE', idempotentReplay: false });
      const replay = await submit(payload);
      expect(replay.status).toBe(422);
      expect(replay.body).toEqual({ ...first.body, idempotentReplay: true });
    });

    it('PendingReference → 202 com nextReferenceCheckAt; replay também 202', async () => {
      const wallet = await openWallet();
      const payload = wager(wallet, 'e-rb', { kind: 'ROLLBACK', referenceExternalTransactionId: 'missing' });
      const first = await submit(payload);
      expect(first.status).toBe(202);
      expect(first.body).toMatchObject({ status: 'PENDING_REFERENCE', idempotentReplay: false });
      expect(new Date(first.body.nextReferenceCheckAt).toISOString()).toBe(first.body.nextReferenceCheckAt);
      const replay = await submit(payload);
      expect(replay.status).toBe(202);
      expect(replay.body.idempotentReplay).toBe(true);
    });

    it('mesma key com payload diferente → 409 IDEMPOTENCY_CONFLICT com existingTransactionId', async () => {
      const wallet = await openWallet();
      const first = await submit(wager(wallet, 'e-c'));
      const conflict = await submit(wager(wallet, 'e-c', { money: { amount: '11.00', currency: 'BRL' } }));
      expect(conflict.status).toBe(409);
      expect(conflict.body).toEqual({
        error: { code: 'IDEMPOTENCY_CONFLICT', message: expect.any(String), existingTransactionId: first.body.transactionId },
      });
    });

    it('lock da wallet ocupado → 503 TRANSIENT_FAILURE com Retry-After e conflito na métrica', async () => {
      const wallet = await openWallet();
      const before = await metricsText();
      const trx = await knex().transaction();
      try {
        await trx.raw('select id from wallets where id = ? for update', [wallet.id]);
        const response = await submit(wager(wallet, 'e-lock'));
        expect(response.status).toBe(503);
        expect(response.headers.get('retry-after')).toBe('1');
        expect(response.body).toEqual({ error: { code: 'TRANSIENT_FAILURE', message: expect.any(String) } });
      } finally {
        await trx.rollback();
      }
      expect(counter(await metricsText(), 'wagering_lock_conflicts_total')).toBe(counter(before, 'wagering_lock_conflicts_total') + 1);
    }, 15_000);

    it('correlationId do header chega ao evento da outbox', async () => {
      const wallet = await openWallet();
      const response = await submit(wager(wallet, 'e-corr'), undefined, { 'x-correlation-id': 'corr-bet-1' });
      expect(response.headers.get('x-correlation-id')).toBe('corr-bet-1');
      const events = await knex()('outbox_messages').whereRaw(`payload->>'correlationId' = ?`, ['corr-bet-1']);
      expect(events.map((row) => row.event_type).sort()).toEqual(['WagerTransactionProcessed', 'WalletBalanceChanged']);
    });
  });

  describe('consultas', () => {
    it('GET de wallet e de transação (por id e por provider + externalId)', async () => {
      const wallet = await openWallet();
      const processed = await submit(wager(wallet, 'e-get'));
      const byWallet = await call('GET', `/wallets/${wallet.id}`);
      expect(byWallet.body).toEqual({ id: wallet.id, playerId: 'player-1', balance: { amount: '90.00', currency: 'BRL' }, version: 2 });
      const byId = await call('GET', `/wagering/transactions/${processed.body.transactionId}`);
      expect(byId.status).toBe(200);
      expect(byId.body).toMatchObject({ kind: 'BET', status: 'PROCESSED', failureCode: null, referenceExternalTransactionId: null, nextReferenceCheckAt: null });
      const byExternal = await call('GET', '/providers/provider-a/wagering/transactions/e-get');
      expect(byExternal.body).toEqual(byId.body);
    });

    it('404 NOT_FOUND quando não existe', async () => {
      const id = '00000000-0000-4000-8000-000000000000';
      for (const [method, path] of [
        ['GET', `/wallets/${id}`],
        ['GET', `/wallets/${id}/ledger`],
        ['GET', `/wagering/transactions/${id}`],
        ['GET', '/providers/p/wagering/transactions/e'],
        ['POST', `/wallets/${id}/reconciliation`],
      ] as const) {
        const response = await call(method, path);
        expect(response.status).toBe(404);
        expect(response.body.error.code).toBe('NOT_FOUND');
      }
    });

    it('id que não é UUID → 400 INVALID_INPUT (não 500)', async () => {
      for (const [method, path] of [
        ['GET', '/wallets/abc'],
        ['GET', '/wallets/abc/ledger'],
        ['GET', '/wagering/transactions/abc'],
        ['POST', '/wallets/abc/reconciliation'],
      ] as const) {
        const response = await call(method, path);
        expect(response.status).toBe(400);
        expect(response.body.error.code).toBe('INVALID_INPUT');
      }
    });
  });

  describe('envelope de erro único', () => {
    it('JSON malformado → 400 INVALID_INPUT', async () => {
      const response = await call('POST', '/wallets', '{"playerId": ');
      expect(response.status).toBe(400);
      expect(response.body).toEqual({ error: { code: 'INVALID_INPUT', message: expect.any(String) } });
      expect(response.headers.get('x-correlation-id')).toBeTruthy();
    });

    it('rota desconhecida → 404 NOT_FOUND', async () => {
      const response = await call('GET', '/nao-existe');
      expect(response.status).toBe(404);
      expect(response.body).toEqual({ error: { code: 'NOT_FOUND', message: expect.any(String) } });
    });
  });

  describe('ledger paginado', () => {
    async function readAll(walletId: string, limit: number, afterFirstPage?: () => Promise<void>) {
      const ids: string[] = [];
      let cursor: string | null = null;
      let pages = 0;
      do {
        const query: string = cursor === null ? `?limit=${limit}` : `?limit=${limit}&cursor=${cursor}`;
        const page = await call('GET', `/wallets/${walletId}/ledger${query}`);
        expect(page.status).toBe(200);
        ids.push(...(page.body.items as Array<{ id: string }>).map((item) => item.id));
        cursor = page.body.nextCursor;
        if (pages++ === 0 && afterFirstPage) await afterFirstPage();
      } while (cursor !== null);
      return ids;
    }

    it('percorre tudo sem duplicar nem pular, mesmo com inserções durante a leitura', async () => {
      const wallet = await openWallet();
      for (let i = 0; i < 4; i++) expect((await submit(wager(wallet, `e-l${i}`))).status).toBe(200);
      const ids = await readAll(wallet.id, 2, async () => {
        expect((await submit(wager(wallet, 'e-late'))).status).toBe(200);
      });
      const all = await knex()('wallet_ledger_entries').where({ wallet_id: wallet.id }).orderBy('seq').pluck('id');
      expect(all).toHaveLength(6);
      expect(ids).toEqual(all);
    });

    it('cursor é estável: a mesma página antes e depois de novas inserções', async () => {
      const wallet = await openWallet();
      for (let i = 0; i < 3; i++) await submit(wager(wallet, `e-s${i}`));
      const first = await call('GET', `/wallets/${wallet.id}/ledger?limit=2`);
      const cursor = first.body.nextCursor as string;
      expect(cursor).toMatch(/^[A-Za-z0-9_-]+$/);
      const before = await call('GET', `/wallets/${wallet.id}/ledger?limit=2&cursor=${cursor}`);
      await submit(wager(wallet, 'e-s9'));
      const after = await call('GET', `/wallets/${wallet.id}/ledger?limit=2&cursor=${cursor}`);
      expect(after.body.items).toEqual(before.body.items);
    });

    it('última página tem nextCursor null; limit padrão 50', async () => {
      const wallet = await openWallet();
      const exact = await call('GET', `/wallets/${wallet.id}/ledger?limit=1`);
      expect(exact.body.items).toHaveLength(1);
      expect(exact.body.nextCursor).toBeNull();
      for (let i = 0; i < 51; i++) await submit(wager(wallet, `e-d${i}`, { money: { amount: '1.00', currency: 'BRL' } }));
      const page = await call('GET', `/wallets/${wallet.id}/ledger`);
      expect(page.body.items).toHaveLength(50);
      expect(page.body.nextCursor).not.toBeNull();
    }, 30_000);

    it('cursor e limit inválidos → 400', async () => {
      const wallet = await openWallet();
      const encode = (text: string) => Buffer.from(text).toString('base64url');
      for (const query of [
        'cursor=',
        'cursor=abc',
        `cursor=${encode('v1:-1')}`,
        `cursor=${encode('v1:9223372036854775808')}`,
        `cursor=${encode('v1:99999999999999999999')}`,
        `cursor=${encode('1')}`,
        'cursor=a&cursor=b',
        'limit=0',
        'limit=201',
        'limit=abc',
        'limit=1e1',
        'limit=1&limit=2',
      ]) {
        const response = await call('GET', `/wallets/${wallet.id}/ledger?${query}`);
        expect(response.status, query).toBe(400);
        expect(response.body.error.code).toBe('INVALID_INPUT');
      }
    });
  });

  describe('reconciliação', () => {
    it('consistente: devolve os saldos, diferença zero e checkedEntries', async () => {
      const wallet = await openWallet();
      await submit(wager(wallet, 'e-r1'));
      const response = await call('POST', `/wallets/${wallet.id}/reconciliation`);
      expect(response.status).toBe(200);
      expect(response.body).toEqual({
        walletId: wallet.id,
        storedBalance: { amount: '90.00', currency: 'BRL' },
        calculatedBalance: { amount: '90.00', currency: 'BRL' },
        difference: { amount: '0.00', currency: 'BRL' },
        consistent: true,
        checkedEntries: 2,
      });
    });

    it('divergente: sinaliza, conta na métrica e não corrige o saldo', async () => {
      const wallet = await openWallet();
      // Corrompe o saldo por fora, com os triggers desligados só nesta transação.
      await knex().transaction(async (trx) => {
        await trx.raw('set local session_replication_role = replica');
        await trx('wallets').where({ id: wallet.id }).update({ balance: '70.00' });
      });
      const before = counter(await metricsText(), 'wagering_reconciliation_divergences_total');
      const response = await call('POST', `/wallets/${wallet.id}/reconciliation`);
      expect(response.body).toMatchObject({
        storedBalance: { amount: '70.00' },
        calculatedBalance: { amount: '100.00' },
        difference: { amount: '-30.00' },
        consistent: false,
        checkedEntries: 1,
      });
      expect(counter(await metricsText(), 'wagering_reconciliation_divergences_total')).toBe(before + 1);
      const [row] = await knex()('wallets').where({ id: wallet.id });
      expect(row.balance).toBe('70.00');
    });
  });

  describe('observabilidade', () => {
    it('X-Correlation-Id válido é devolvido; inválido ou ausente é substituído por um UUID', async () => {
      const valid = await call('GET', '/health/live', undefined, { 'x-correlation-id': 'abc-123' });
      expect(valid.headers.get('x-correlation-id')).toBe('abc-123');
      for (const header of ['x'.repeat(129), 'tem espaço', '<script>']) {
        const response = await call('GET', '/health/live', undefined, { 'x-correlation-id': header });
        expect(response.headers.get('x-correlation-id')).toMatch(/^[0-9a-f-]{36}$/);
      }
      const missing = await call('GET', '/health/live');
      expect(missing.headers.get('x-correlation-id')).toMatch(/^[0-9a-f-]{36}$/);
    });

    it('/metrics é aberto e só tem labels de conjunto fechado', async () => {
      const wallet = await openWallet();
      const before = await metricsText();
      await submit(wager(wallet, 'e-m1'));
      await submit(wager(wallet, 'e-m1'));
      await submit(wager(wallet, 'e-m1', { money: { amount: '12.00', currency: 'BRL' } }));
      await submit(wager(wallet, 'e-m2', { kind: 'kind-aleatorio-123' }));
      await submit(wager(wallet, 'e-m3', { money: { amount: '999.00', currency: 'BRL' } }));
      const text = await metricsText();
      const delta = (series: string) => counter(text, series) - counter(before, series);
      expect(delta('wagering_transactions_total{status="PROCESSED",kind="BET",failure_code="NONE"}')).toBe(2);
      expect(delta('wagering_transactions_total{status="INVALID_INPUT",kind="UNKNOWN",failure_code="NONE"}')).toBe(1);
      expect(delta('wagering_transactions_total{status="REJECTED",kind="BET",failure_code="INSUFFICIENT_BALANCE"}')).toBe(1);
      expect(text).not.toContain('kind-aleatorio-123');
      expect(delta('wagering_idempotent_replays_total{kind="BET"}')).toBe(1);
      expect(delta('wagering_idempotency_conflicts_total{kind="BET"}')).toBe(1);
      expect(text).toContain('wagering_processing_duration_seconds_bucket');
      expect(text).toContain('wagering_retries_total 0');
      expect(text).toContain('wagering_dlq_messages_total 0');
      expect(text).toContain('wagering_outbox_lag_seconds 0');
      expect(text).not.toMatch(/(walletId|transactionId|providerId|wallet_id|provider_id)=/);
      expect(text).not.toContain(wallet.id);
    });
  });
});

/** Soma das séries de um contador no texto do Prometheus. */
function counter(text: string, name: string): number {
  return text
    .split('\n')
    .filter((line) => line.startsWith(name) && !line.startsWith('#'))
    .reduce((total, line) => total + Number(line.split(' ').at(-1)), 0);
}
