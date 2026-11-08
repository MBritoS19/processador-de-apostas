import type { EntityManager } from '@mikro-orm/postgresql';
import type {
  ReconciliationEntryRow,
  WalletReconciliationReader,
  WalletReconciliationSnapshot,
} from '../../application/ports/wallet-reconciliation-reader';

interface EntrySqlRow {
  entry_id: string;
  transaction_id: string;
  direction: string;
  amount: string;
  currency: string;
  tx_wallet_id: string | null;
  tx_kind: string | null;
  tx_status: string | null;
  tx_amount: string | null;
  tx_currency: string | null;
  ref_kind: string | null;
}

/**
 * Lê wallet, lançamentos, transações PROCESSED e o saldo da conta PLAYER no diário num único snapshot (REPEATABLE READ, READ ONLY),
 * sem lock: a reconciliação não bloqueia escritas e não vê um commit pela metade.
 * Custo O(lançamentos + transações) da wallet; ver ARCHITECTURE.md → "Reconciliação".
 */
export class PostgresWalletReconciliationReader implements WalletReconciliationReader {
  constructor(private readonly em: EntityManager) {}

  async read(walletId: string): Promise<WalletReconciliationSnapshot | undefined> {
    return this.em.getKnex().transaction(async (trx) => {
      await trx.raw('set transaction isolation level repeatable read, read only');
      const [wallet] = (
        await trx.raw<{ rows: Array<{ balance: string; currency: string }> }>(
          'select balance::text as balance, currency from wallets where id = ?',
          [walletId],
        )
      ).rows;
      if (!wallet) return undefined;

      // Toda transação é buscada pelo id do lançamento (sem filtrar wallet): um lançamento que
      // aponte para transação de outra wallet ainda acha a transação e é conferido.
      const entries = (
        await trx.raw<{ rows: EntrySqlRow[] }>(
          `select l.id as entry_id, l.transaction_id, l.direction, l.amount::text as amount, l.currency,
                  t.wallet_id as tx_wallet_id, t.kind as tx_kind, t.status as tx_status, t.amount::text as tx_amount, t.currency as tx_currency,
                  r.kind as ref_kind
             from wallet_ledger_entries l
             left join wager_transactions t on t.id = l.transaction_id
             left join wager_transactions r on r.id = t.reference_transaction_id
            where l.wallet_id = ?
            order by l.seq`,
          [walletId],
        )
      ).rows.map(toEntryRow);

      const processed = (
        await trx.raw<{ rows: Array<{ transaction_id: string; kind: string; entries: string }> }>(
          `select t.id as transaction_id, t.kind, count(l.id)::text as entries
             from wager_transactions t
             left join wallet_ledger_entries l on l.transaction_id = t.id
            where t.wallet_id = ? and t.status = 'PROCESSED'
            group by t.id, t.kind`,
          [walletId],
        )
      ).rows.map((row) => ({ transactionId: row.transaction_id, kind: row.kind, entries: Number(row.entries) }));

      // Saldo da conta PLAYER no diário, no mesmo snapshot (servido por ux_accounts_player e ix_postings_account).
      const [journal] = (
        await trx.raw<{ rows: Array<{ balance: string }> }>(
          `select coalesce(sum(case p.direction when 'CREDIT' then p.amount else -p.amount end), 0)::numeric(20,2)::text as balance
             from accounts a join journal_postings p on p.account_id = a.id
            where a.kind = 'PLAYER' and a.wallet_id = ?`,
          [walletId],
        )
      ).rows;

      return { balance: wallet.balance, currency: wallet.currency, journalBalance: journal?.balance ?? '0.00', entries, processed };
    });
  }
}

function toEntryRow(row: EntrySqlRow): ReconciliationEntryRow {
  return {
    entryId: row.entry_id,
    transactionId: row.transaction_id,
    direction: row.direction,
    amount: row.amount,
    currency: row.currency,
    ...(row.tx_wallet_id !== null &&
      row.tx_kind !== null &&
      row.tx_status !== null &&
      row.tx_amount !== null &&
      row.tx_currency !== null && {
        transaction: {
          walletId: row.tx_wallet_id,
          kind: row.tx_kind,
          status: row.tx_status,
          amount: row.tx_amount,
          currency: row.tx_currency,
          ...(row.ref_kind !== null && { referenceKind: row.ref_kind }),
        },
      }),
  };
}
