import type { EntityManager } from '@mikro-orm/postgresql';
import { AccountKind, type AccountRef, type JournalEntry } from '../../domain/journal-entry';

/**
 * Gravação do diário de partidas dobradas em SQL direto (nada do diário é lido pelo ORM).
 * ARCHITECTURE.md → "Diário de partidas dobradas".
 */

/** Chave natural da conta; cada kind é servido pelo seu índice único parcial. */
function accountKey(account: AccountRef, currency: string): { kind: AccountKind; walletId: string | null; providerId: string | null; currency: string } {
  switch (account.kind) {
    case AccountKind.Player:
      return { kind: account.kind, walletId: account.walletId, providerId: null, currency };
    case AccountKind.ProviderHouse:
      return { kind: account.kind, walletId: null, providerId: account.providerId, currency };
    case AccountKind.Funding:
      return { kind: account.kind, walletId: null, providerId: null, currency };
  }
}

const CONFLICT_TARGET: Record<AccountKind, string> = {
  [AccountKind.Player]: `(wallet_id) where kind = 'PLAYER'`,
  [AccountKind.ProviderHouse]: `(provider_id, currency) where kind = 'PROVIDER_HOUSE'`,
  [AccountKind.Funding]: `(currency) where kind = 'FUNDING'`,
};

type Key = ReturnType<typeof accountKey>;

/** Filtro de uma conta, no formato que casa com o índice único parcial do kind. */
function accountFilter(key: Key): { sql: string; params: unknown[] } {
  switch (key.kind) {
    case AccountKind.Player:
      return { sql: `(kind = 'PLAYER' and wallet_id = ?)`, params: [key.walletId] };
    case AccountKind.ProviderHouse:
      return { sql: `(kind = 'PROVIDER_HOUSE' and provider_id = ? and currency = ?)`, params: [key.providerId, key.currency] };
    case AccountKind.Funding:
      return { sql: `(kind = 'FUNDING' and currency = ?)`, params: [key.currency] };
  }
}

/** Ids das contas já existentes, numa consulta só. */
async function findAccounts(em: EntityManager, keys: readonly Key[]): Promise<Map<string, string>> {
  const filters = keys.map(accountFilter);
  const rows = await em.execute<Array<{ id: string; kind: string; wallet_id: string | null; provider_id: string | null; currency: string }>>(
    `select id, kind, wallet_id, provider_id, currency from accounts where ${filters.map((f) => f.sql).join(' or ')}`,
    filters.flatMap((f) => f.params),
  );
  return new Map(rows.map((row) => [keyId({ kind: row.kind as AccountKind, walletId: row.wallet_id, providerId: row.provider_id, currency: row.currency }), row.id]));
}

const keyId = (k: Key) => `${k.kind}|${k.walletId ?? ''}|${k.providerId ?? ''}|${k.currency}`;

/**
 * Resolve as contas das pernas, criando as que faltam. PLAYER nasce sob o lock da wallet (sem disputa);
 * HOUSE e FUNDING são compartilhadas: `on conflict do nothing` espera o INSERT concorrente da mesma
 * conta e a releitura (novo snapshot, READ COMMITTED) a enxerga. A espera só existe no primeiro uso
 * de um (provider, moeda) ou de uma moeda nova, e cabe no lock_timeout.
 */
async function resolveAccounts(em: EntityManager, entry: JournalEntry): Promise<Map<string, string>> {
  const keys = entry.postings.map((p) => accountKey(p.account, entry.currency));
  let ids = await findAccounts(em, keys);
  const missing = keys.filter((k) => !ids.has(keyId(k)));
  if (missing.length === 0) return ids;
  for (const key of missing) {
    await em.execute(
      `insert into accounts (id, kind, wallet_id, provider_id, currency, created_at)
       values (gen_random_uuid(), ?, ?, ?, ?, ?) on conflict ${CONFLICT_TARGET[key.kind]} do nothing`,
      [key.kind, key.walletId, key.providerId, key.currency, entry.createdAt],
    );
  }
  ids = await findAccounts(em, keys);
  const unresolved = keys.find((k) => !ids.has(keyId(k)));
  if (unresolved) throw new Error(`conta ${unresolved.kind} não resolvida após o insert`);
  return ids;
}

/** Lançamento e pernas num único statement. Débito = crédito é conferido no COMMIT (`trg_journal_balanced`). */
export async function insertJournalEntry(em: EntityManager, entry: JournalEntry): Promise<void> {
  const accounts = await resolveAccounts(em, entry);
  const legs = entry.postings.map((p) => ({
    accountId: accounts.get(keyId(accountKey(p.account, entry.currency)))!,
    direction: p.direction,
    amount: p.money.amount,
  }));
  await em.execute(
    `with entry as (
       insert into journal_entries (id, wager_transaction_id, currency, created_at) values (?, ?, ?, ?)
     )
     insert into journal_postings (id, journal_entry_id, account_id, direction, amount, currency)
     values ${legs.map(() => '(gen_random_uuid(), ?, ?, ?, ?::numeric, ?)').join(', ')}`,
    [
      entry.id,
      entry.transactionId,
      entry.currency,
      entry.createdAt,
      ...legs.flatMap((leg) => [entry.id, leg.accountId, leg.direction, leg.amount, entry.currency]),
    ],
  );
}
