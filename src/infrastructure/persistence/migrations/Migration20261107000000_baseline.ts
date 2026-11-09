import { Migration } from '@mikro-orm/migrations';

/**
 * Migration de base, intencionalmente vazia: só prova o ciclo up/down do
 * migrator (registro e remoção em `mikro_orm_migrations`).
 * As tabelas de domínio nascem na migration `…100000_schema`.
 */
export class Migration20261107000000_baseline extends Migration {
  override async up(): Promise<void> {}

  override async down(): Promise<void> {}
}
