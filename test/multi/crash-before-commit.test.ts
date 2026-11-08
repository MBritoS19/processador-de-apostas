import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import type { SQSClient } from '@aws-sdk/client-sqs';
import type { MikroORM } from '@mikro-orm/postgresql';
import { loadConfig } from '../../src/infrastructure/config/app-config';
import { createSqsClient } from '../../src/infrastructure/messaging/sqs.client';
import { expectLedgerConsistent, openOrm, seedWallet, truncateAll } from '../integration/persistence/db';
import { createQueues, deleteQueues, envelope, queueDepth, readDlq, send, type TestQueues } from '../integration/interfaces/sqs-harness';
import { createEventsQueue, deleteQueue, drain } from '../integration/workers/outbox-harness';
import { eventually, freePort, Instance } from './harness';

/**
 * CHALLENGE §3: "o processo pode morrer ANTES do commit". Um processo real da aplicação recebe a
 * mensagem pelo SQS e fica parado dentro da transação financeira (débito e ledger já gravados,
 * ainda sem commit), num trigger criado só por este teste. Ele leva SIGKILL nesse ponto. O Postgres
 * desfaz a transação, nada persiste, a mensagem volta à fila e outra instância a processa uma vez.
 */
describe('multi-instância: processo morto antes do commit', () => {
  let orm: MikroORM;
  let sqs: SQSClient;
  let queues: TestQueues;
  let events: { name: string; url: string };
  const instances: Instance[] = [];
  const knex = () => orm.em.getKnex();

  const env = (): Record<string, string> => ({
    NODE_ENV: 'test',
    SQS_CONSUMER_ENABLED: 'true',
    OUTBOX_PUBLISHER_ENABLED: 'true',
    PENDING_REFERENCE_WORKER_ENABLED: 'false',
    SQS_WAGER_QUEUE_NAME: queues.queueName,
    SQS_WAGER_DLQ_NAME: queues.dlqName,
    SQS_WAGER_EVENTS_QUEUE_NAME: events.name,
    SQS_WAIT_TIME_SECONDS: '1',
    SQS_VISIBILITY_TIMEOUT_SECONDS: '4',
    OUTBOX_POLL_INTERVAL_MS: '100',
  });

  async function dropGate(): Promise<void> {
    await knex().raw('drop trigger if exists hold_before_commit on outbox_messages');
    await knex().raw('drop function if exists hold_before_commit()');
    await knex().raw('drop table if exists test_commit_gate');
  }

  beforeAll(async () => {
    orm = await openOrm();
    await truncateAll(orm);
    sqs = createSqsClient(loadConfig());
    queues = await createQueues(sqs);
    events = await createEventsQueue(sqs);
  });

  afterAll(async () => {
    await Promise.all(instances.map((instance) => instance.kill()));
    await dropGate();
    await Promise.allSettled([deleteQueues(sqs, queues), deleteQueue(sqs, events.url)]);
    await orm.close(true);
    sqs.destroy();
  });

  it('SIGKILL com a transação aberta: nada persiste, a mensagem volta e é processada uma única vez', async () => {
    // seedWallet grava direto (sem outbox), então o único evento que passa pelo trigger é o do BET.
    const wallet = await seedWallet(orm, '100.00');
    await knex().raw('create table test_commit_gate (released boolean not null)');
    await knex().raw('insert into test_commit_gate values (false)');
    await knex().raw(`create function hold_before_commit() returns trigger language plpgsql as $$
      begin
        while not (select released from test_commit_gate) loop perform pg_sleep(0.05); end loop;
        return new;
      end $$`);
    await knex().raw('create trigger hold_before_commit before insert on outbox_messages for each row execute function hold_before_commit()');

    const doomed = new Instance('K', await freePort(), env());
    instances.push(doomed);
    doomed.start();
    await doomed.waitReady();

    const message = envelope(wallet, { data: { money: { amount: '30.00', currency: 'BRL' } } });
    await send(sqs, queues.queueUrl, message);

    // A transação do processo K está aberta e parada dentro do trigger.
    let backendPid = 0;
    await eventually(
      'transação de K parada antes do commit',
      async () => {
        const { rows } = await knex().raw<{ rows: { pid: number }[] }>(
          `select pid from pg_stat_activity where wait_event = 'PgSleep' and state = 'active'`,
        );
        expect(rows).toHaveLength(1);
        backendPid = rows[0]!.pid;
      },
      20_000,
      50,
    );

    await doomed.kill();
    expect(doomed.count('sqs_message_acked'), 'K não confirmou nada').toBe(0);
    // Libera o trigger: o backend termina o INSERT, descobre o cliente morto e desfaz a transação.
    await knex().raw('update test_commit_gate set released = true');
    await eventually(
      'Postgres encerrou a sessão de K',
      async () => {
        const { rows } = await knex().raw<{ rows: unknown[] }>('select 1 from pg_stat_activity where pid = ?', [backendPid]);
        expect(rows).toHaveLength(0);
      },
      20_000,
      50,
    );
    await dropGate();

    const snapshot = async () =>
      (
        await knex().raw<{ rows: Record<string, string>[] }>(
          `select (select balance::text from wallets where id = :w) as balance,
                  (select count(*) from wager_transactions where wallet_id = :w and kind = 'BET')::text as bets,
                  (select count(*) from wallet_ledger_entries where wallet_id = :w)::text as ledger,
                  (select count(*) from inbox_messages)::text as inbox,
                  (select count(*) from outbox_messages)::text as outbox`,
          { w: wallet.walletId },
        )
      ).rows[0];
    expect(await snapshot(), 'nada da transação de K persistiu').toEqual({ balance: '100.00', bets: '0', ledger: '1', inbox: '0', outbox: '0' });
    expect(await queueDepth(sqs, queues.queueUrl), 'a mensagem continua na fila (sem ack)').toBe(1);

    // Outra instância assume: a mensagem volta depois da visibilidade e é aplicada uma vez.
    const heir = new Instance('L', await freePort(), env());
    instances.push(heir);
    heir.start();
    await heir.waitReady();
    await eventually('L confirmou a mensagem', () => expect(heir.count('sqs_message_acked:PROCESSED')).toBe(1), 30_000, 100);
    await eventually('outbox publicada', async () => {
      const [row] = (await knex().raw<{ rows: { pending: string }[] }>(
        'select count(*)::text as pending from outbox_messages where published_at is null',
      )).rows;
      expect(row?.pending).toBe('0');
    }, 20_000, 100);

    expect(await snapshot()).toEqual({ balance: '70.00', bets: '1', ledger: '2', inbox: '1', outbox: '2' });
    const [bet] = (await knex().raw<{ rows: { status: string }[] }>(
      `select status from wager_transactions where wallet_id = ? and kind = 'BET'`,
      [wallet.walletId],
    )).rows;
    expect(bet?.status).toBe('PROCESSED');
    expect(heir.count('sqs_message_acked:DUPLICATE_MESSAGE'), 'sem segunda entrega').toBe(0);
    expect(await queueDepth(sqs, queues.queueUrl)).toBe(0);
    expect(await readDlq(sqs, queues.dlqUrl)).toEqual([]);
    const outboxIds = (await knex()('outbox_messages').select('id')).map((r) => r.id as string).sort();
    expect((await drain(sqs, events.url)).map((m) => m.body.eventId as string).sort()).toEqual(outboxIds);
    await expectLedgerConsistent(orm, wallet.walletId);
  }, 120_000);
});
