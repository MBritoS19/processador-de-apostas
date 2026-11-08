import { Migration } from '@mikro-orm/migrations';

/**
 * Fase 7: `correlation_id` da requisição que criou a transação. O worker de referências
 * pendentes usa esse valor nos eventos da resolução. Nulo nas linhas anteriores a esta
 * migration (o worker usa o id da transação como fallback; ARCHITECTURE.md → "Worker de referências pendentes").
 *
 * Gravado no INSERT e imutável: entra na tupla de identidade do trigger de guarda.
 */
const GUARD = (immutable: string) => `
  create or replace function wager_transactions_guard() returns trigger language plpgsql as $$
  begin
    if tg_op = 'DELETE' then
      raise exception 'wager_transactions: DELETE não é permitido (transação %)', old.id
        using errcode = '23001';
    end if;
    if old.status in ('PROCESSED','REJECTED','FAILED') then
      raise exception 'wager_transactions: transação % está em estado terminal (%) e não pode mudar', old.id, old.status
        using errcode = '23001';
    end if;
    if (${immutable.replaceAll('$', 'new.')}) is distinct from (${immutable.replaceAll('$', 'old.')}) then
      raise exception 'wager_transactions: identidade e payload da transação % são imutáveis', old.id
        using errcode = '23001';
    end if;
    return new;
  end
  $$`;

const BASE_COLUMNS =
  '$id, $provider_id, $external_transaction_id, $idempotency_key, $payload_hash, $wallet_id, $player_id, ' +
  '$round_id, $game_id, $kind, $amount, $currency, $reference_external_transaction_id, $created_at';

export class Migration20261107500000_correlation_id extends Migration {
  override async up(): Promise<void> {
    this.addSql('alter table wager_transactions add column correlation_id text');
    this.addSql(GUARD(`${BASE_COLUMNS}, $correlation_id`));
  }

  override async down(): Promise<void> {
    this.addSql(GUARD(BASE_COLUMNS));
    this.addSql('alter table wager_transactions drop column correlation_id');
  }
}
