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

    await migrator.up();
    expect(await migrator.getPendingMigrations()).toEqual([]);
  });

  it('up é idempotente', async () => {
    // Monta o próprio estado: não depende da ordem dos testes anteriores.
    await orm.getMigrator().up();
    const before = await appliedNames();
    expect(await orm.getMigrator().up()).toEqual([]);
    expect(await appliedNames()).toEqual(before);
  });
});
