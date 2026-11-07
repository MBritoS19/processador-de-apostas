import { expect } from 'bun:test';
import { MikroORM } from '@mikro-orm/postgresql';
import { randomUUID } from 'node:crypto';
import { loadConfig } from '../../../src/infrastructure/config/app-config';
import { buildMikroOrmConfig } from '../../../src/infrastructure/persistence/mikro-orm.config';

/** ORM contra o banco wagering_test (Postgres real do docker compose), já migrado. */
export async function openOrm(): Promise<MikroORM> {
  const config = loadConfig();
  expect(config.databaseUrl).toEndWith('/wagering_test');
  const orm = await MikroORM.init(buildMikroOrmConfig(config));
  await orm.getMigrator().up();
  return orm;
}

/** TRUNCATE não dispara os triggers de linha (append-only, guarda de transação). */
export async function truncateAll(orm: MikroORM): Promise<void> {
  await orm.em
    .getKnex()
    .raw('truncate wallets, wager_transactions, wallet_ledger_entries, inbox_messages, outbox_messages cascade');
}

/** Garante que o banco rejeitou com o SQLSTATE (e a constraint, quando houver) esperados. */
export async function expectPgError(action: Promise<unknown>, code: string, constraint?: string): Promise<void> {
  const error = await action.then(
    () => undefined,
    (e: unknown) => e as { code?: string; constraint?: string },
  );
  expect(error).toBeDefined();
  expect(error?.code).toBe(code);
  if (constraint !== undefined) expect(error?.constraint).toBe(constraint);
}

export const PG = {
  checkViolation: '23514',
  uniqueViolation: '23505',
  foreignKeyViolation: '23503',
  restrictViolation: '23001',
} as const;

export const T0 = new Date('2026-11-07T12:00:00.000Z');

type Row = Record<string, unknown>;

export function walletRow(overrides: Row = {}): Row {
  return {
    id: randomUUID(),
    player_id: `player-${randomUUID()}`,
    currency: 'BRL',
    balance: '0.00',
    version: 1,
    created_at: T0,
    updated_at: T0,
    ...overrides,
  };
}

export function transactionRow(overrides: Row & { wallet_id: string }): Row {
  const external = `ext-${randomUUID()}`;
  return {
    id: randomUUID(),
    provider_id: 'provider-a',
    external_transaction_id: external,
    idempotency_key: `provider-a:${external}`,
    payload_hash: 'hash',
    player_id: 'player',
    round_id: 'round-1',
    game_id: 'game-1',
    kind: 'BET',
    amount: '10.00',
    currency: 'BRL',
    status: 'PENDING',
    created_at: T0,
    ...overrides,
  };
}

export function processed(overrides: Row & { wallet_id: string }): Row {
  return transactionRow({ status: 'PROCESSED', processed_at: T0, observed_balance: '0.00', ...overrides });
}

export function ledgerRow(overrides: Row & { wallet_id: string; transaction_id: string }): Row {
  return {
    id: randomUUID(),
    direction: 'CREDIT',
    amount: '10.00',
    currency: 'BRL',
    balance_before: '0.00',
    balance_after: '10.00',
    created_at: T0,
    ...overrides,
  };
}

/** Wallet BRL com saldo inicial, já com a transação OPENING e o lançamento CREDIT (como a Fase 4 fará). */
export async function seedWallet(orm: MikroORM, balance: string): Promise<{ walletId: string; openingId: string }> {
  const wallet = walletRow({ balance });
  const walletId = wallet.id as string;
  const opening = processed({ wallet_id: walletId, kind: 'OPENING', amount: balance, observed_balance: balance });
  const openingId = opening.id as string;
  await orm.em.getKnex().transaction(async (trx) => {
    await trx('wallets').insert(wallet);
    await trx('wager_transactions').insert(opening);
    await trx('wallet_ledger_entries').insert(
      ledgerRow({ wallet_id: walletId, transaction_id: openingId, amount: balance, balance_after: balance }),
    );
  });
  return { walletId, openingId };
}
