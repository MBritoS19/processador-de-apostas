/**
 * CLI de migrations. Usa o Migrator programaticamente para não depender do
 * CLI do MikroORM rodando sob Bun.
 *
 *   bun run migration:up                  # aplica todas as pendentes
 *   bun run migration:down                # reverte a última
 *   bun run migration:down -- --all       # reverte todas
 *   bun run migration:pending             # lista as pendentes
 *   bun run migration:create -- <nome>    # cria um arquivo (nome: letras, dígitos e _)
 *
 * Saída: 0 em sucesso, 1 em erro de uso, configuração ou execução.
 */
import { MikroORM } from '@mikro-orm/postgresql';
import { loadConfig } from '../config/app-config';
import { buildMikroOrmConfig } from './mikro-orm.config';

const USAGE = 'Uso: migrate.ts up | down [--all] | pending | create <nome>';

/** O nome vira parte do nome da classe TS (`Migration<ts>_<nome>`): precisa ser identificador válido. */
const MIGRATION_NAME = /^[A-Za-z0-9_]+$/;

export type MigrateCommand =
  | { kind: 'up' }
  | { kind: 'down'; all: boolean }
  | { kind: 'pending' }
  | { kind: 'create'; name: string };

export class UsageError extends Error {
  constructor(message: string) {
    super(`${message}\n${USAGE}`);
    this.name = 'UsageError';
  }
}

/** Valida os argumentos antes de qualquer conexão com o banco. */
export function parseArgs(argv: readonly string[]): MigrateCommand {
  // `bun run x -- args` pode ou não repassar o `--` literal: ignoramos.
  const [command, ...rest] = argv.filter((arg) => arg !== '--');
  const flags = rest.filter((arg) => arg.startsWith('-'));
  const positional = rest.filter((arg) => !arg.startsWith('-'));

  const allowOnly = (allowed: readonly string[]): void => {
    const unknown = flags.filter((flag) => !allowed.includes(flag));
    if (unknown.length > 0) throw new UsageError(`Opção desconhecida: ${unknown.join(', ')}`);
  };
  const noPositional = (): void => {
    if (positional.length > 0) throw new UsageError(`Argumento inesperado: ${positional.join(' ')}`);
  };

  switch (command) {
    case 'up':
    case 'pending':
      allowOnly([]);
      noPositional();
      return { kind: command };
    case 'down':
      allowOnly(['--all']);
      noPositional();
      return { kind: 'down', all: flags.includes('--all') };
    case 'create': {
      allowOnly([]);
      const [name, ...extra] = positional;
      if (!name) throw new UsageError('Informe o nome da migration.');
      if (extra.length > 0) throw new UsageError(`Argumento inesperado: ${extra.join(' ')}`);
      if (!MIGRATION_NAME.test(name)) {
        throw new UsageError(`Nome inválido "${name}": use apenas letras, dígitos e _ (ex.: add_wallets).`);
      }
      return { kind: 'create', name };
    }
    default:
      throw new UsageError(command ? `Comando desconhecido: "${command}".` : 'Informe um comando.');
  }
}

async function run(command: MigrateCommand): Promise<void> {
  const orm = await MikroORM.init(buildMikroOrmConfig(loadConfig()));
  const migrator = orm.getMigrator();

  try {
    switch (command.kind) {
      case 'up': {
        const applied = await migrator.up();
        log(applied.length ? `Aplicadas: ${applied.map((m) => m.name).join(', ')}` : 'Nada a aplicar.');
        break;
      }
      case 'down': {
        const reverted = command.all ? await migrator.down({ to: 0 }) : await migrator.down();
        log(reverted.length ? `Revertidas: ${reverted.map((m) => m.name).join(', ')}` : 'Nada a reverter.');
        break;
      }
      case 'pending': {
        const pending = await migrator.getPendingMigrations();
        log(pending.length ? pending.map((m) => m.name).join('\n') : 'Nenhuma pendente.');
        break;
      }
      case 'create': {
        const result = await migrator.createMigration(undefined, true, false, command.name);
        log(`Criada: ${result.fileName}`);
        break;
      }
    }
  } finally {
    await orm.close(true);
  }
}

function log(message: string): void {
  process.stdout.write(`${message}\n`);
}

if (import.meta.main) {
  Promise.resolve()
    .then(() => run(parseArgs(process.argv.slice(2))))
    .catch((error: unknown) => {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
      process.exit(1);
    });
}
