import { Migration } from '@mikro-orm/migrations';

/**
 * Fase 3: uma transação é revertida no máximo uma vez no total (REFUND ou ROLLBACK, não os
 * dois). Com o índice por (referência, kind) da Fase 2, uma BET poderia receber um REFUND e
 * um ROLLBACK, creditando o jogador duas vezes. Interpretação documentada no ARCHITECTURE.md → "Regras de negócio".
 */
export class Migration20261107200000_one_reversal_per_reference extends Migration {
  override async up(): Promise<void> {
    this.addSql('drop index ux_wager_tx_one_reversal_per_kind');
    this.addSql(`
      create unique index ux_wager_tx_one_reversal on wager_transactions (reference_transaction_id)
        where status = 'PROCESSED' and kind in ('REFUND','ROLLBACK')`);
  }

  override async down(): Promise<void> {
    this.addSql('drop index ux_wager_tx_one_reversal');
    this.addSql(`
      create unique index ux_wager_tx_one_reversal_per_kind on wager_transactions (reference_transaction_id, kind)
        where status = 'PROCESSED' and kind in ('REFUND','ROLLBACK')`);
  }
}
