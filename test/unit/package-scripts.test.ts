import { describe, expect, it } from 'bun:test';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Contrato dos scripts documentados no README.
 * Se um script for criado, removido ou renomeado, atualize a documentação e esta lista.
 */
const DOCUMENTED_SCRIPTS = [
  'start',
  'start:dev',
  'migration:up',
  'migration:down',
  'migration:pending',
  'migration:create',
  'typecheck',
  'test:unit',
  'test:integration',
  'test:concurrency',
  'test:multi',
  'test:chaos',
  'test:load',
  'demo',
] as const;

const root = join(import.meta.dir, '..', '..');
const pkg = (await Bun.file(join(root, 'package.json')).json()) as { scripts: Record<string, string> };

describe('scripts do package.json', () => {
  it('são exatamente os documentados', () => {
    expect(Object.keys(pkg.scripts).sort()).toEqual([...DOCUMENTED_SCRIPTS].sort());
  });

  it('as suítes de teste apontam para pastas existentes', () => {
    for (const suite of ['unit', 'integration', 'concurrency', 'multi', 'chaos', 'load']) {
      expect(pkg.scripts[`test:${suite}`]).toContain(`./test/${suite}`);
      expect(existsSync(join(root, 'test', suite))).toBe(true);
    }
  });

  it('os scripts de migration chamam o CLI com o subcomando certo', () => {
    for (const command of ['up', 'down', 'pending', 'create']) {
      expect(pkg.scripts[`migration:${command}`]).toBe(`bun src/infrastructure/persistence/migrate.ts ${command}`);
    }
  });
});
