import { describe, expect, it } from 'bun:test';
import { parseArgs, UsageError } from '../../../src/infrastructure/persistence/migrate';

const usageError = (argv: string[]): string => {
  try {
    parseArgs(argv);
  } catch (error) {
    if (error instanceof UsageError) return error.message;
    throw error;
  }
  throw new Error(`esperava UsageError para ${JSON.stringify(argv)}`);
};

describe('migrate parseArgs', () => {
  it('up e pending', () => {
    expect(parseArgs(['up'])).toEqual({ kind: 'up' });
    expect(parseArgs(['pending'])).toEqual({ kind: 'pending' });
  });

  it('down reverte só a última por padrão', () => {
    expect(parseArgs(['down'])).toEqual({ kind: 'down', all: false });
  });

  it('down --all, com ou sem o "--" repassado pelo bun run', () => {
    expect(parseArgs(['down', '--all'])).toEqual({ kind: 'down', all: true });
    expect(parseArgs(['down', '--', '--all'])).toEqual({ kind: 'down', all: true });
  });

  it('create com nome válido, com ou sem "--"', () => {
    expect(parseArgs(['create', 'add_wallets'])).toEqual({ kind: 'create', name: 'add_wallets' });
    expect(parseArgs(['create', '--', 'AddWallets2'])).toEqual({ kind: 'create', name: 'AddWallets2' });
  });

  it.each(['add-wallets', 'add wallets', 'add.wallets', 'ação'])(
    'create rejeita nome que não vira identificador TS: %p',
    (name) => {
      expect(usageError(['create', name])).toStartWith(`Nome inválido "${name}"`);
    },
  );

  it('create sem nome ou com argumentos extras', () => {
    expect(usageError(['create'])).toStartWith('Informe o nome da migration.');
    expect(usageError(['create', 'a', 'b'])).toStartWith('Argumento inesperado: b');
  });

  it('rejeita flags desconhecidas em vez de ignorá-las', () => {
    expect(usageError(['down', '--al'])).toStartWith('Opção desconhecida: --al');
    expect(usageError(['down', '-all'])).toStartWith('Opção desconhecida: -all');
    expect(usageError(['up', '--all'])).toStartWith('Opção desconhecida: --all');
  });

  it('rejeita comando ausente ou desconhecido, com o uso na mensagem', () => {
    expect(usageError([])).toStartWith('Informe um comando.');
    expect(usageError(['upp'])).toStartWith('Comando desconhecido: "upp".');
    expect(usageError(['upp'])).toContain('Uso: migrate.ts');
  });
});
