import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { MikroORM } from '@mikro-orm/postgresql';
import { loadConfig } from '../../../src/infrastructure/config/app-config';
import { buildMikroOrmConfig } from '../../../src/infrastructure/persistence/mikro-orm.config';

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

    // Fase 6 (outbox_seq) + as 3 da Fase 3.
    for (let i = 0; i < 4; i++) await migrator.down();
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

    await migrator.down();
    expect(await outboxSchema()).toEqual([]);

    await migrator.up();
    expect(await outboxSchema()).toEqual(['ix_outbox_pending_aggregate', 'seq']);
  });

  it('up é idempotente', async () => {
    // Monta o próprio estado: não depende da ordem dos testes anteriores.
    await orm.getMigrator().up();
    const before = await appliedNames();
    expect(await orm.getMigrator().up()).toEqual([]);
    expect(await appliedNames()).toEqual(before);
  });
});
