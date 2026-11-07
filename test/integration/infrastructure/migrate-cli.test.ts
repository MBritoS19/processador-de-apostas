import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { MikroORM } from '@mikro-orm/postgresql';
import { readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { loadConfig } from '../../../src/infrastructure/config/app-config';
import { buildMikroOrmConfig } from '../../../src/infrastructure/persistence/mikro-orm.config';

/** O CLI real (bun run migration:*) contra o banco wagering_test. */
const root = join(import.meta.dir, '..', '..', '..');
const migrationsDir = join(root, 'src', 'infrastructure', 'persistence', 'migrations');

async function cli(...args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn(['bun', 'run', ...args], {
    cwd: root,
    env: { ...process.env, NODE_ENV: 'test' },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { code, stdout, stderr };
}

describe('CLI de migrations', () => {
  let orm: MikroORM;
  const applied = async () =>
    (await orm.em.getConnection().execute<{ name: string }[]>('select name from mikro_orm_migrations order by id')).map(
      (row) => row.name,
    );

  beforeAll(async () => {
    const config = loadConfig();
    expect(config.databaseUrl).toEndWith('/wagering_test');
    orm = await MikroORM.init(buildMikroOrmConfig(config));
    await orm.getMigrator().up();
  });

  afterAll(async () => {
    await orm.getMigrator().up();
    await orm.close(true);
  });

  it('migration:down reverte só a última; migration:pending a lista; migration:up reaplica', async () => {
    const before = await applied();
    expect(before.length).toBeGreaterThan(0);

    const down = await cli('migration:down');
    expect(down.code).toBe(0);
    expect(await applied()).toEqual(before.slice(0, -1));

    const pending = await cli('migration:pending');
    expect(pending.code).toBe(0);
    expect(pending.stdout).toContain(before.at(-1) ?? '');

    const up = await cli('migration:up');
    expect(up.code).toBe(0);
    expect(await applied()).toEqual(before);
  }, 30_000);

  it('migration:down -- --all reverte todas', async () => {
    const result = await cli('migration:down', '--', '--all');
    expect(result.code).toBe(0);
    expect(await applied()).toEqual([]);
  }, 30_000);

  it('erro de uso sai com 1 sem criar arquivo', async () => {
    const before = readdirSync(migrationsDir);

    const noName = await cli('migration:create');
    expect(noName.code).toBe(1);
    expect(noName.stderr).toContain('Informe o nome da migration.');

    const badName = await cli('migration:create', '--', 'add-wallets');
    expect(badName.code).toBe(1);
    expect(badName.stderr).toContain('Nome inválido');

    expect(readdirSync(migrationsDir)).toEqual(before);
  }, 30_000);

  it('migration:create -- <nome> gera uma migration carregável', async () => {
    const before = new Set(readdirSync(migrationsDir));
    const result = await cli('migration:create', '--', 'cli_smoke_test');
    const created = readdirSync(migrationsDir).filter((file) => !before.has(file));

    try {
      expect(result.code).toBe(0);
      expect(created).toHaveLength(1);
      expect(created[0]).toMatch(/^Migration\d{14}_cli_smoke_test\.ts$/);
      // Carregável: a classe exportada compila e estende Migration.
      const module = (await import(join(migrationsDir, created[0] ?? ''))) as Record<string, unknown>;
      expect(Object.keys(module)).toEqual([created[0]?.replace(/\.ts$/, '') ?? '']);
    } finally {
      for (const file of created) rmSync(join(migrationsDir, file));
    }
  }, 30_000);
});
