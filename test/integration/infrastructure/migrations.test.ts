import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { MikroORM } from '@mikro-orm/postgresql';
import { randomUUID } from 'node:crypto';
import { loadConfig } from '../../../src/infrastructure/config/app-config';
import { buildMikroOrmConfig } from '../../../src/infrastructure/persistence/mikro-orm.config';
import { PG, T0, expectPgError, seedWallet, transactionRow } from '../persistence/db';

/** Postgres real (docker compose), banco wagering_test via .env.test. */
describe('migrations', () => {
  let orm: MikroORM;

  const appliedNames = async (): Promise<string[]> => {
    const rows = await orm.em
      .getConnection()
      .execute<{ name: string }[]>('select name from mikro_orm_migrations order by id');
    return rows.map((row) => row.name);
  };

  /** Tabelas e funções criadas pelas migrations, em ordem alfabética. */
  const SCHEMA_OBJECTS = [
    'inbox_messages',
    'outbox_messages',
    'wager_transactions',
    'wager_transactions_guard',
    'wallet_balance_matches_ledger',
    'wallet_ledger_entries',
    'wallet_ledger_entries_append_only',
    'wallets',
  ];

  const existingSchemaObjects = async (): Promise<string[]> => {
    const rows = await orm.em.getConnection().execute<{ name: string }[]>(
      `select table_name as name from information_schema.tables
         where table_schema = 'public' and table_name <> 'mikro_orm_migrations'
       union
       select routine_name from information_schema.routines where routine_schema = 'public'
       order by name`,
    );
    return rows.map((row) => row.name);
  };

  beforeAll(async () => {
    const config = loadConfig();
    expect(config.databaseUrl).toEndWith('/wagering_test');
    orm = await MikroORM.init(buildMikroOrmConfig(config));
    await orm.getMigrator().down({ to: 0 });
  });

  afterAll(async () => {
    // Deixa o banco de testes migrado para as próximas suítes.
    await orm.getMigrator().up();
    await orm.close(true);
  });

  it('aplica todas as migrations pendentes', async () => {
    const migrator = orm.getMigrator();
    const pending = (await migrator.getPendingMigrations()).map((m) => m.name);
    expect(pending).toContain('Migration20261107000000_baseline');

    await migrator.up();

    expect(await migrator.getPendingMigrations()).toEqual([]);
    expect(await appliedNames()).toEqual(pending);
  });

  it('reverte todas e reaplica (ciclo up → down → up)', async () => {
    const migrator = orm.getMigrator();

    await migrator.down({ to: 0 });
    expect(await appliedNames()).toEqual([]);
    expect(await existingSchemaObjects()).toEqual([]);

    await migrator.up();
    expect(await migrator.getPendingMigrations()).toEqual([]);
    expect(await existingSchemaObjects()).toEqual(SCHEMA_OBJECTS);
  });

  /** Reverte a da Fase 6 e as posteriores (`to` é inclusivo). */
  const PHASE6_OUTBOX_SEQ = 'Migration20261107400000_outbox_seq';

  it('down das migrations da Fase 3 restaura os índices e constraints da Fase 2', async () => {
    const migrator = orm.getMigrator();
    await migrator.up();
    const schemaObjects = async () => {
      const rows = await orm.em.getConnection().execute<{ name: string; definition: string }[]>(
        `select indexname as name, indexdef as definition from pg_indexes where tablename = 'wager_transactions'
         union all
         select conname, pg_get_constraintdef(oid) from pg_constraint
          where conrelid = 'wager_transactions'::regclass and conname = 'ck_wager_tx_failure_code'`,
      );
      return Object.fromEntries(rows.map((row) => [row.name, row.definition]));
    };

    const phase3 = await schemaObjects();
    expect(Object.keys(phase3)).toEqual(
      expect.arrayContaining(['ux_wager_tx_one_reversal', 'uq_wager_tx_provider_idempotency_key']),
    );
    expect(phase3.ck_wager_tx_failure_code).toContain('BALANCE_LIMIT_EXCEEDED');

    // As 3 da Fase 3 e tudo depois delas (`to` é inclusivo).
    await migrator.down({ to: 'Migration20261107200000_one_reversal_per_reference' });
    const phase2 = await schemaObjects();
    expect(phase2).toHaveProperty('ux_wager_tx_one_reversal_per_kind');
    expect(phase2).toHaveProperty('uq_wager_tx_idempotency_key');
    expect(phase2).not.toHaveProperty('ux_wager_tx_one_reversal');
    expect(phase2).not.toHaveProperty('uq_wager_tx_provider_idempotency_key');
    expect(phase2.ck_wager_tx_failure_code).not.toContain('BALANCE_LIMIT_EXCEEDED');

    await migrator.up();
    expect(await schemaObjects()).toEqual(phase3);
  });

  it('down da migration da Fase 6 remove seq e o índice da ordem por agregado', async () => {
    const migrator = orm.getMigrator();
    await migrator.up();
    const outboxSchema = async () => {
      const rows = await orm.em.getConnection().execute<{ name: string }[]>(
        `select column_name as name from information_schema.columns where table_name = 'outbox_messages' and column_name = 'seq'
         union all
         select indexname from pg_indexes where tablename = 'outbox_messages' and indexname = 'ix_outbox_pending_aggregate'
         order by name`,
      );
      return rows.map((row) => row.name);
    };
    expect(await outboxSchema()).toEqual(['ix_outbox_pending_aggregate', 'seq']);

    await migrator.down({ to: PHASE6_OUTBOX_SEQ });
    expect(await outboxSchema()).toEqual([]);

    await migrator.up();
    expect(await outboxSchema()).toEqual(['ix_outbox_pending_aggregate', 'seq']);
  });

  it('down da migration da Fase 7 remove correlation_id e devolve o guard sem ela; up volta a proteger a coluna', async () => {
    const migrator = orm.getMigrator();
    await migrator.up();
    const knex = orm.em.getKnex();
    const hasColumn = async () =>
      (await knex.raw<{ rows: unknown[] }>(
        `select 1 from information_schema.columns where table_name = 'wager_transactions' and column_name = 'correlation_id'`,
      )).rows.length === 1;
    const wallet = await seedWallet(orm, '100.00');
    const pending = transactionRow({
      wallet_id: wallet.walletId,
      player_id: wallet.playerId,
      kind: 'ROLLBACK',
      reference_external_transaction_id: 'bet-x',
      status: 'PENDING_REFERENCE',
      reference_attempts: 1,
      next_reference_check_at: T0,
    });
    await knex('wager_transactions').insert(pending);

    await migrator.down({ to: 'Migration20261107500000_correlation_id' });
    expect(await hasColumn()).toBe(false);
    // O guard restaurado funciona sem a coluna: UPDATE permitido passa, identidade continua imutável.
    await knex('wager_transactions').where({ id: pending.id }).update({ reference_attempts: 2 });
    await expectPgError(knex('wager_transactions').where({ id: pending.id }).update({ round_id: 'outra' }), PG.restrictViolation);

    await migrator.up();
    expect(await hasColumn()).toBe(true);
    await knex('wager_transactions').where({ id: pending.id }).update({ reference_attempts: 3 });
    await expectPgError(knex('wager_transactions').where({ id: pending.id }).update({ correlation_id: 'x' }), PG.restrictViolation);
    await knex.raw('truncate wallets, wager_transactions, wallet_ledger_entries, inbox_messages, outbox_messages cascade');
  });

  it('up da Fase 6 numera linhas existentes por (occurred_at, id), não pela ordem física, e a sequência continua', async () => {
    const migrator = orm.getMigrator();
    await migrator.up();
    await migrator.down({ to: PHASE6_OUTBOX_SEQ }); // sem seq
    const knex = orm.em.getKnex();
    await knex.raw('truncate outbox_messages');
    const aggregate = randomUUID();
    const at = (second: number) => new Date(Date.UTC(2026, 10, 7, 12, 0, second));
    // Inseridos fora de ordem: a ordem física (heap) é 3, 1, 2.
    const rows = [3, 1, 2].map((second) => ({
      id: randomUUID(),
      aggregate_id: aggregate,
      event_type: 'WalletBalanceChanged',
      payload: JSON.stringify({ second }),
      occurred_at: at(second),
      attempts: 0,
    }));
    for (const row of rows) await knex.insert(row).into('outbox_messages');

    await migrator.up();
    const numbered = await orm.em
      .getConnection()
      .execute<Array<{ seq: string; second: number }>>(
        `select seq::text, (payload->>'second')::int as second from outbox_messages order by seq`,
      );
    expect(numbered).toEqual([
      { seq: '1', second: 1 },
      { seq: '2', second: 2 },
      { seq: '3', second: 3 },
    ]);

    // A sequência continua do maior valor.
    await knex
      .insert({ ...rows[0], id: randomUUID(), payload: JSON.stringify({ second: 4 }) })
      .into('outbox_messages');
    const [last] = await orm.em
      .getConnection()
      .execute<Array<{ seq: string }>>('select max(seq)::text as seq from outbox_messages');
    expect(last?.seq).toBe('4');
    await knex.raw('truncate outbox_messages');
  });

  it('up é idempotente', async () => {
    // Monta o próprio estado: não depende da ordem dos testes anteriores.
    await orm.getMigrator().up();
    const before = await appliedNames();
    expect(await orm.getMigrator().up()).toEqual([]);
    expect(await appliedNames()).toEqual(before);
  });
});
