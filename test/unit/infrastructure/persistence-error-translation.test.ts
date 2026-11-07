import { describe, expect, it } from 'bun:test';
import {
  ConnectionException,
  DeadlockException,
  DriverException,
  LockWaitTimeoutException,
  UniqueConstraintViolationException,
} from '@mikro-orm/core';
import {
  TransientPersistenceError,
  UniqueViolationError,
} from '../../../src/application/ports/wager-unit-of-work';
import { translatePersistenceError } from '../../../src/infrastructure/persistence/mikro-orm-wager-unit-of-work';

/** Erros como o MikroORM os entrega: a exceção convertida copia `code`/`constraint` do erro do pg. */
const pgError = (fields: Record<string, unknown>) => Object.assign(new Error('pg'), fields);

describe('translatePersistenceError', () => {
  it.each([
    ['55P03', 'lock_timeout', LockWaitTimeoutException],
    ['40P01', 'deadlock', DeadlockException],
    ['40001', 'serialization', DriverException],
  ] as const)('SQLSTATE %s → TransientPersistenceError(%s)', (code, reason, Exception) => {
    const translated = translatePersistenceError(new Exception(pgError({ code })));
    expect(translated).toBeInstanceOf(TransientPersistenceError);
    expect((translated as TransientPersistenceError).reason).toBe(reason);
  });

  it.each([
    ['ConnectionException', new ConnectionException(pgError({ code: 'ECONNREFUSED' }))],
    ['pool esgotado (KnexTimeoutError)', Object.assign(new Error('Knex: Timeout acquiring a connection'), { name: 'KnexTimeoutError' })],
    ['erro de rede aninhado', Object.assign(new Error('x'), { cause: pgError({ code: 'ECONNRESET' }) })],
  ])('%s → unavailable', (_, error) => {
    const translated = translatePersistenceError(error);
    expect(translated).toBeInstanceOf(TransientPersistenceError);
    expect((translated as TransientPersistenceError).reason).toBe('unavailable');
  });

  it.each([
    ['uq_wager_tx_provider_idempotency_key', 'idempotency'],
    ['uq_wager_tx_provider_external', 'idempotency'],
    ['pk_inbox_messages', 'inbox'],
  ] as const)('23505 em %s → UniqueViolationError(%s)', (constraint, kind) => {
    const translated = translatePersistenceError(new UniqueConstraintViolationException(pgError({ code: '23505', constraint })));
    expect(translated).toBeInstanceOf(UniqueViolationError);
    expect((translated as UniqueViolationError).kind).toBe(kind);
  });

  it('23505 em outra constraint (ex.: reversão, ledger) não é traduzido: é bug', () => {
    const error = new UniqueConstraintViolationException(pgError({ code: '23505', constraint: 'ux_wager_tx_one_reversal' }));
    expect(translatePersistenceError(error)).toBe(error);
  });

  it.each(['toString', 'constructor', '23514'])('código %p não é transitório', (code) => {
    const error = pgError({ code });
    expect(translatePersistenceError(error)).toBe(error);
  });
});
