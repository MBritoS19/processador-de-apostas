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

  it('up é idempotente', async () => {
    // Monta o próprio estado: não depende da ordem dos testes anteriores.
    await orm.getMigrator().up();
    const before = await appliedNames();
    expect(await orm.getMigrator().up()).toEqual([]);
    expect(await appliedNames()).toEqual(before);
  });
});
