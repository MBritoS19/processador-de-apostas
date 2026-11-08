import 'reflect-metadata';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import type { INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { MikroORM } from '@mikro-orm/postgresql';
import { randomUUID } from 'node:crypto';
import { AppModule } from '../../../src/app.module';
import { loadConfig } from '../../../src/infrastructure/config/app-config';
import { createSqsClient } from '../../../src/infrastructure/messaging/sqs.client';
import { ObservabilityMetrics } from '../../../src/infrastructure/observability/metrics';
import { countRows } from '../application/harness';
import { expectJournalConsistent, expectLedgerConsistent, openOrm, seedWallet, truncateAll } from '../persistence/db';
import {
  createQueues,
  deleteQueues,
  envelope,
  eventually,
  queueDepth,
  readDlq,
  send,
  startConsumerApp,
  type TestQueues,
} from './sqs-harness';

/**
 * Se o diário de partidas dobradas falhar, a transação SQL inteira falha: nada de transação, saldo,
 * ledger, inbox, outbox ou diário fica gravado. A falha é REAL: um trigger de teste soma 0,01 à perna
 * de crédito, e o `trg_journal_balanced` recusa no COMMIT. Pela fila, o erro é permanente: DLQ direto.
 */
describe('falha do diário de partidas dobradas (Postgres e LocalStack reais)', () => {
  let orm: MikroORM;
  const sql = (statement: string) => orm.em.getKnex().raw(statement);

  async function corruptJournal(): Promise<void> {
    await sql(`create or replace function test_corrupt_journal() returns trigger language plpgsql as $$
      begin
        if new.direction = 'CREDIT' then new.amount := new.amount + 0.01; end if;
        return new;
      end $$`);
    await sql(`create trigger test_corrupt_journal before insert on journal_postings for each row execute function test_corrupt_journal()`);
  }

  async function heal(): Promise<void> {
    await sql('drop trigger if exists test_corrupt_journal on journal_postings');
    await sql('drop function if exists test_corrupt_journal()');
  }

  beforeAll(async () => {
    orm = await openOrm();
  });

  beforeEach(async () => {
    await truncateAll(orm);
  });

  afterEach(async () => {
    await heal();
  });

  afterAll(async () => {
    await orm.close(true);
  });

  const balance = async (walletId: string) =>
    ((await orm.em.getKnex()('wallets').where({ id: walletId }).first('balance')) as { balance: string }).balance;

  async function expectOnlyOpening(walletId: string): Promise<void> {
    expect(await balance(walletId)).toBe('100.00');
    expect(await countRows(orm, 'wager_transactions', { wallet_id: walletId })).toBe(1);
    expect(await countRows(orm, 'wallet_ledger_entries', { wallet_id: walletId })).toBe(1);
    expect(await countRows(orm, 'journal_entries')).toBe(1);
    expect(await countRows(orm, 'inbox_messages')).toBe(0);
    await expectLedgerConsistent(orm, walletId);
    await expectJournalConsistent(orm, walletId);
  }

  describe('HTTP', () => {
    let app: INestApplication;
    let url: string;

    beforeAll(async () => {
      app = await NestFactory.create(AppModule.register(loadConfig()), { logger: false });
      await app.listen(0);
      url = `http://127.0.0.1:${(app.getHttpServer().address() as { port: number }).port}`;
    });

    afterAll(async () => {
      await app.close();
    });

    const post = async (path: string, body: unknown, headers: Record<string, string> = {}) => {
      const response = await fetch(`${url}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...headers },
        body: JSON.stringify(body),
      });
      return { status: response.status, body: (await response.json()) as Record<string, any> };
    };

    const bet = (wallet: { id: string; playerId: string }, externalTransactionId: string) =>
      post(
        '/wagering/transactions',
        {
          providerId: 'provider-a',
          externalTransactionId,
          playerId: wallet.playerId,
          walletId: wallet.id,
          roundId: 'round-1',
          gameId: 'game-1',
          kind: 'BET',
          money: { amount: '10.00', currency: 'BRL' },
        },
        { 'idempotency-key': `provider-a:${externalTransactionId}` },
      );

    it('BET: 500, nada gravado; reenviar a mesma key depois processa normalmente', async () => {
      const opened = await post('/wallets', { playerId: 'player-1', initialBalance: { amount: '100.00', currency: 'BRL' } });
      expect(opened.status).toBe(201);
      const wallet = { id: opened.body.id as string, playerId: 'player-1' };
      const outboxBefore = await countRows(orm, 'outbox_messages');

      await corruptJournal();
      const failed = await bet(wallet, 'bet-1');
      expect(failed.status).toBe(500);
      await expectOnlyOpening(wallet.id);
      expect(await countRows(orm, 'outbox_messages')).toBe(outboxBefore);

      await heal();
      const retried = await bet(wallet, 'bet-1');
      expect(retried.status).toBe(200);
      expect(retried.body.status).toBe('PROCESSED');
      expect(retried.body.idempotentReplay).toBe(false);
      expect(await balance(wallet.id)).toBe('90.00');
      await expectLedgerConsistent(orm, wallet.id);
      await expectJournalConsistent(orm, wallet.id);
    });

    it('abertura de wallet com saldo: 500 e nenhuma wallet criada', async () => {
      await corruptJournal();
      const failed = await post('/wallets', { playerId: 'player-2', initialBalance: { amount: '100.00', currency: 'BRL' } });
      expect(failed.status).toBe(500);
      for (const table of ['wallets', 'wager_transactions', 'wallet_ledger_entries', 'outbox_messages', 'journal_entries', 'accounts']) {
        expect(await countRows(orm, table)).toBe(0);
      }
    });
  });

  describe('SQS', () => {
    const sqs = createSqsClient(loadConfig());
    let queues: TestQueues;
    let app: INestApplication | undefined;

    beforeEach(async () => {
      queues = await createQueues(sqs);
    });

    afterEach(async () => {
      await app?.close();
      app = undefined;
      await deleteQueues(sqs, queues);
    });

    afterAll(() => {
      sqs.destroy();
    });

    const metric = async (name: 'retries' | 'dlqMessages') =>
      (await app!.get(ObservabilityMetrics)[name].get()).values.reduce((sum, value) => sum + value.value, 0);

    it('erro do diário é permanente: DLQ JOURNAL_INTEGRITY_VIOLATION na 1ª entrega, sem retry e sem efeito', async () => {
      const wallet = await seedWallet(orm, '100.00');
      await corruptJournal();
      app = await startConsumerApp({ queues });
      const external = `bet-${randomUUID()}`;
      await send(sqs, queues.queueUrl, envelope(wallet, { data: { externalTransactionId: external, idempotencyKey: `provider-a:${external}` } }));

      let dead: Awaited<ReturnType<typeof readDlq>> = [];
      await eventually(async () => {
        dead = await readDlq(sqs, queues.dlqUrl);
        expect(dead).toHaveLength(1);
      });
      expect(dead[0]?.reason).toBe('JOURNAL_INTEGRITY_VIOLATION');
      expect(dead[0]?.detail).toBe('JournalIntegrityError');
      await eventually(async () => expect(await queueDepth(sqs, queues.queueUrl)).toBe(0));
      expect(await metric('retries')).toBe(0);
      expect(await metric('dlqMessages')).toBe(1);
      await expectOnlyOpening(wallet.walletId);
    });
  });
});
