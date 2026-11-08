import { describe, expect, it } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const DOMAIN_DIR = join(import.meta.dir, '../../../src/domain');

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return entry.name.endsWith('.ts') ? [path] : [];
  });
}

// CHALLENGE §6.1: o domínio não depende de tipos do ORM nem de decorators do NestJS.
describe('fronteira do domínio', () => {
  it('nenhum arquivo de src/domain importa NestJS, MikroORM ou camadas externas', () => {
    const files = sourceFiles(DOMAIN_DIR);
    expect(files.length).toBeGreaterThan(0);
    const importPattern = /(?:from\s+|import\s*\(\s*|require\s*\(\s*)['"]([^'"]+)['"]/g;
    const offenders: string[] = [];
    for (const file of files) {
      for (const [, spec] of readFileSync(file, 'utf8').matchAll(importPattern)) {
        if (/^@nestjs\/|^@mikro-orm\/|^knex$|^pg$|^@aws-sdk\//.test(spec!) || /\/(application|infrastructure|interfaces)\//.test(spec!)) {
          offenders.push(`${file}: ${spec}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});
