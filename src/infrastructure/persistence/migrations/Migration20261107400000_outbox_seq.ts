import { Migration } from '@mikro-orm/migrations';

/**
 * Ordem por agregado no outbox publisher. `seq` é atribuído no INSERT, que acontece
 * sob o lock da wallet: dentro de um agregado, ordem de `seq` = ordem de commit. O índice
 * parcial serve o `not exists` do claim ("há evento anterior pendente do mesmo agregado?").
 *
 * Linhas já existentes: `add column ... generated as identity` numeraria na ordem física do
 * heap, que não é a de inserção. Por isso o backfill é explícito, por `(occurred_at, id)`, e só
 * depois a coluna vira identity, com a sequência continuando do maior valor.
 */
export class Migration20261107400000_outbox_seq extends Migration {
  override async up(): Promise<void> {
    this.addSql('alter table outbox_messages add column seq bigint');
    this.addSql(`
      update outbox_messages o set seq = ordered.n
      from (select id, row_number() over (order by occurred_at, id) as n from outbox_messages) ordered
      where o.id = ordered.id`);
    this.addSql('alter table outbox_messages alter column seq set not null');
    this.addSql('alter table outbox_messages alter column seq add generated always as identity');
    this.addSql(`
      select setval(pg_get_serial_sequence('outbox_messages', 'seq'),
                    coalesce((select max(seq) from outbox_messages), 0) + 1, false)`);
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
