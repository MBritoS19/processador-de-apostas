import { expect } from 'bun:test';
import { MikroORM, type Knex } from '@mikro-orm/postgresql';
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
    .raw('truncate wallets, wager_transactions, wallet_ledger_entries, inbox_messages, outbox_messages, accounts, journal_entries, journal_postings cascade');
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
export async function seedWallet(
  orm: MikroORM,
  balance: string,
  overrides: Row = {},
): Promise<{ walletId: string; openingId: string; playerId: string }> {
  const wallet = walletRow({ balance, ...overrides });
  const walletId = wallet.id as string;
  const playerId = wallet.player_id as string;
  const currency = wallet.currency as string;
  const opening = processed({
    wallet_id: walletId,
    player_id: playerId,
    kind: 'OPENING',
    amount: balance,
    currency,
    observed_balance: balance,
  });
  const openingId = opening.id as string;
  await orm.em.getKnex().transaction(async (trx) => {
    await trx('wallets').insert(wallet);
    await trx('wager_transactions').insert(opening);
    await trx('wallet_ledger_entries').insert(
      ledgerRow({ wallet_id: walletId, transaction_id: openingId, amount: balance, currency, balance_after: balance }),
    );
  });
  return { walletId, openingId, playerId };
}

/** `wallet.balance` == saldo reconstruído pelo ledger, e todo lançamento é de transação PROCESSED de mesmo valor. */
export async function expectLedgerConsistent(orm: MikroORM, walletId: string): Promise<void> {
  const knex = orm.em.getKnex();
  const [row] = await knex.raw<{ rows: { balance: string; ledger: string }[] }>(
    `select w.balance::text as balance,
            coalesce(sum(case l.direction when 'CREDIT' then l.amount else -l.amount end), 0)::numeric(20,2)::text as ledger
       from wallets w left join wallet_ledger_entries l on l.wallet_id = w.id
      where w.id = ? group by w.id`,
    [walletId],
  ).then((r) => r.rows);
  expect(row).toBeDefined();
  expect(row?.ledger).toBe(row?.balance);

  const orphans = await knex.raw<{ rows: unknown[] }>(
    `select l.id from wallet_ledger_entries l join wager_transactions t on t.id = l.transaction_id
      where l.wallet_id = ? and (t.status <> 'PROCESSED' or t.amount <> l.amount)`,
    [walletId],
  );
  expect(orphans.rows).toEqual([]);
}

/** Conta do diário pela chave natural (moeda à parte). */
export type JournalAccount = { kind: 'PLAYER'; walletId: string } | { kind: 'PROVIDER_HOUSE'; providerId: string } | { kind: 'FUNDING' };

/** Id da conta; cria se faltar (SQL direto, sem concorrência: só para semear testes). */
export async function accountId(knex: Knex, account: JournalAccount, currency: string): Promise<string> {
  const key = {
    kind: account.kind,
    currency,
    wallet_id: account.kind === 'PLAYER' ? account.walletId : null,
    provider_id: account.kind === 'PROVIDER_HOUSE' ? account.providerId : null,
  };
  const found = await knex('accounts').where(key).first<{ id: string } | undefined>('id');
  if (found) return found.id;
  const id = randomUUID();
  await knex('accounts').insert({ id, ...key, created_at: T0 });
  return id;
}

export interface JournalPostingSeed {
  account: JournalAccount;
  direction: 'DEBIT' | 'CREDIT';
  amount: string;
}

/** Lançamento de diário com as pernas dadas. Devolve o id do lançamento. */
export async function insertJournal(
  knex: Knex,
  props: { transactionId: string; currency?: string; postings: JournalPostingSeed[] },
): Promise<string> {
  const currency = props.currency ?? 'BRL';
  const id = randomUUID();
  await knex('journal_entries').insert({ id, wager_transaction_id: props.transactionId, currency, created_at: T0 });
  for (const posting of props.postings) {
    await knex('journal_postings').insert({
      id: randomUUID(),
      journal_entry_id: id,
      account_id: await accountId(knex, posting.account, currency),
      direction: posting.direction,
      amount: posting.amount,
      currency,
    });
  }
  return id;
}

/** Lançamento padrão: perna PLAYER com a direção do ledger; contrapartida FUNDING (OPENING) ou HOUSE do provider. */
export function standardPostings(props: {
  walletId: string;
  kind: string;
  providerId: string;
  direction: 'DEBIT' | 'CREDIT';
  amount: string;
}): JournalPostingSeed[] {
  const counterpart: JournalAccount =
    props.kind === 'OPENING' ? { kind: 'FUNDING' } : { kind: 'PROVIDER_HOUSE', providerId: props.providerId };
  return [
    { account: { kind: 'PLAYER', walletId: props.walletId }, direction: props.direction, amount: props.amount },
    { account: counterpart, direction: props.direction === 'DEBIT' ? 'CREDIT' : 'DEBIT', amount: props.amount },
  ];
}
