import { Migration } from '@mikro-orm/migrations';

/**
 * A idempotency key passa a ser única por provider. Com a unicidade global, um provider
 * podia gravar antes a key de outro (ex.: "provider-a:tx-123") e bloquear para sempre a
 * transação legítima dele, além de receber o id interno dela no conflito.
 */
export class Migration20261107300000_idempotency_per_provider extends Migration {
  override async up(): Promise<void> {
    this.addSql('alter table wager_transactions drop constraint uq_wager_tx_idempotency_key');
    this.addSql(`
      alter table wager_transactions
        add constraint uq_wager_tx_provider_idempotency_key unique (provider_id, idempotency_key)`);
  }

  override async down(): Promise<void> {
    this.addSql('alter table wager_transactions drop constraint uq_wager_tx_provider_idempotency_key');
    this.addSql('alter table wager_transactions add constraint uq_wager_tx_idempotency_key unique (idempotency_key)');
  }
}
