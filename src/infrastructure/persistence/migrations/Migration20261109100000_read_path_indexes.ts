import { Migration } from '@mikro-orm/migrations';

/**
 * Índices dos caminhos de leitura que varriam a tabela inteira (só aditiva; nenhuma regra muda):
 * - `ix_wager_tx_wallet`: transações PROCESSED da wallet na reconciliação (antes, `uq_wager_tx_id_wallet`
 *   com `wallet_id` como segunda coluna, varrendo o índice todo);
 * - `ix_ledger_transaction`: join lançamento ← transação na reconciliação (antes, `uq_ledger_wallet_transaction`
 *   pela segunda coluna);
 * - `ix_outbox_aggregate`: `findPendingReferenceEventId` (antes, `uq_outbox_seq` filtrando `aggregate_id`,
 *   varrendo a outbox, que não tem retenção).
 * ARCHITECTURE.md → "Persistência" → "Migrations".
 */
export class Migration20261109100000_read_path_indexes extends Migration {
  override async up(): Promise<void> {
    this.addSql('create index ix_wager_tx_wallet on wager_transactions (wallet_id)');
    this.addSql('create index ix_ledger_transaction on wallet_ledger_entries (transaction_id)');
    this.addSql('create index ix_outbox_aggregate on outbox_messages (aggregate_id, seq)');
  }

  override async down(): Promise<void> {
    this.addSql('drop index if exists ix_outbox_aggregate');
    this.addSql('drop index if exists ix_ledger_transaction');
    this.addSql('drop index if exists ix_wager_tx_wallet');
  }
}
