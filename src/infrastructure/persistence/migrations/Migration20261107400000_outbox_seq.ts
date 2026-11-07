import { Migration } from '@mikro-orm/migrations';

/**
 * Ordem por agregado no outbox publisher (Fase 6). `seq` é atribuído no INSERT, que acontece
 * sob o lock da wallet: dentro de um agregado, ordem de `seq` = ordem de commit. O índice
 * parcial serve o `not exists` do claim ("há evento anterior pendente do mesmo agregado?").
 */
export class Migration20261107400000_outbox_seq extends Migration {
  override async up(): Promise<void> {
    this.addSql('alter table outbox_messages add column seq bigint generated always as identity');
    this.addSql('alter table outbox_messages add constraint uq_outbox_seq unique (seq)');
    this.addSql(
      'create index ix_outbox_pending_aggregate on outbox_messages (aggregate_id, seq) where published_at is null',
    );
  }

  override async down(): Promise<void> {
    this.addSql('drop index ix_outbox_pending_aggregate');
    this.addSql('alter table outbox_messages drop column seq');
  }
}
