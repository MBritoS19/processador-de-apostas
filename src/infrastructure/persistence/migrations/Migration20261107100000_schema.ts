import { Migration } from '@mikro-orm/migrations';

/**
 * Schema da Fase 2. Toda garantia de unicidade, imutabilidade e não-negatividade
 * está aqui (CHALLENGE §5.9), duplicada de propósito com as verificações do domínio.
 * A tabela "garantia → constraint/trigger" está no ARCHITECTURE.md.
 *
 * - FKs entre tabelas são DEFERRABLE INITIALLY DEFERRED: checadas no COMMIT, então a
 *   ordem dos INSERTs no flush não importa.
 * - Violações de trigger usam SQLSTATE 23001 (restrict_violation); a de saldo × ledger, 23514.
 */

const KINDS = `'OPENING','BET','WIN','LOSS','REFUND','ROLLBACK'`;
const STATUSES = `'PENDING','PENDING_REFERENCE','PROCESSED','REJECTED','FAILED'`;
const FAILURE_CODES = [
  'INSUFFICIENT_BALANCE',
  'REVERSAL_WOULD_OVERDRAW',
  'WALLET_NOT_FOUND',
  'WALLET_PLAYER_MISMATCH',
  'CURRENCY_MISMATCH',
  'REFERENCE_NOT_FOUND',
  'REFERENCE_NOT_PROCESSED',
  'INVALID_REFERENCE_KIND',
  'REFERENCE_ALREADY_REVERSED',
  'AMOUNT_MISMATCH',
  'REFERENCE_ROUND_MISMATCH',
  'REFERENCE_PLAYER_MISMATCH',
  'REFERENCE_WALLET_MISMATCH',
  'INFRASTRUCTURE_FAILURE',
]
  .map((code) => `'${code}'`)
  .join(',');

export class Migration20261107100000_schema extends Migration {
  override async up(): Promise<void> {
    this.addSql(`
      create table wallets (
        id uuid primary key,
        player_id text not null,
        currency char(3) not null,
        balance numeric(20,2) not null,
        version integer not null,
        created_at timestamptz not null,
        updated_at timestamptz not null,
        constraint ck_wallets_currency check (currency ~ '^[A-Z]{3}$'),
        constraint ck_wallets_balance_non_negative check (balance >= 0),
        constraint ck_wallets_version check (version >= 1),
        constraint uq_wallets_player_currency unique (player_id, currency),
        -- alvo das FKs compostas (wallet_id, currency)
        constraint uq_wallets_id_currency unique (id, currency)
      )`);

    this.addSql(`
      create table wager_transactions (
        id uuid primary key,
        provider_id text not null,
        external_transaction_id text not null,
        idempotency_key text not null,
        payload_hash text not null,
        wallet_id uuid not null,
        player_id text not null,
        round_id text not null,
        game_id text not null,
        kind text not null,
        amount numeric(20,2) not null,
        currency char(3) not null,
        reference_external_transaction_id text,
        reference_transaction_id uuid,
        status text not null,
        failure_code text,
        processed_at timestamptz,
        -- saldo observado no processamento (moeda da transação): o replay devolve o original
        observed_balance numeric(20,2),
        reference_attempts integer not null default 0,
        next_reference_check_at timestamptz,
        created_at timestamptz not null,
        -- NULL em REJECTED/FAILED: com MATCH SIMPLE a FK composta (wallet_id, currency) não é checada,
        -- o que deixa gravar rejeições por WALLET_NOT_FOUND e CURRENCY_MISMATCH (auditoria e replay).
        -- Nos demais status a FK vale e o banco garante moeda da transação = moeda da wallet
        -- (ARCHITECTURE.md → "Garantias no schema").
        wallet_fk_currency char(3) generated always as (
          case when status in ('REJECTED','FAILED') then null else currency end
        ) stored,
        constraint ck_wager_tx_currency check (currency ~ '^[A-Z]{3}$'),
        constraint ck_wager_tx_kind check (kind in (${KINDS})),
        constraint ck_wager_tx_status check (status in (${STATUSES})),
        constraint ck_wager_tx_failure_code check (failure_code in (${FAILURE_CODES})),
        constraint ck_wager_tx_amount check (amount >= 0 and (kind = 'LOSS' or amount > 0)),
        constraint ck_wager_tx_observed_balance check (observed_balance >= 0),
        constraint ck_wager_tx_reference_attempts check (reference_attempts >= 0),
        constraint ck_wager_tx_reference_required check (
          kind not in ('REFUND','ROLLBACK') or reference_external_transaction_id is not null
        ),
        constraint ck_wager_tx_processed check ((status = 'PROCESSED') = (processed_at is not null)),
        constraint ck_wager_tx_processed_balance check (status <> 'PROCESSED' or observed_balance is not null),
        constraint ck_wager_tx_processed_reference check (
          status <> 'PROCESSED' or kind not in ('REFUND','ROLLBACK') or reference_transaction_id is not null
        ),
        constraint ck_wager_tx_failure check ((status in ('REJECTED','FAILED')) = (failure_code is not null)),
        constraint ck_wager_tx_pending_reference check (
          status <> 'PENDING_REFERENCE'
          or (reference_external_transaction_id is not null and next_reference_check_at is not null)
        ),
        constraint uq_wager_tx_idempotency_key unique (idempotency_key),
        constraint uq_wager_tx_provider_external unique (provider_id, external_transaction_id),
        -- alvo das FKs que exigem "mesma wallet" (referência e lançamento)
        constraint uq_wager_tx_id_wallet unique (id, wallet_id),
        constraint fk_wager_tx_wallet_currency foreign key (wallet_id, wallet_fk_currency)
          references wallets (id, currency) deferrable initially deferred,
        constraint fk_wager_tx_reference foreign key (reference_transaction_id, wallet_id)
          references wager_transactions (id, wallet_id) deferrable initially deferred
      )`);

    this.addSql(`
      create unique index ux_wager_tx_one_reversal_per_kind on wager_transactions (reference_transaction_id, kind)
        where status = 'PROCESSED' and kind in ('REFUND','ROLLBACK')`);
    this.addSql(`
      create index ix_wager_tx_reference_check_due on wager_transactions (next_reference_check_at)
        where status = 'PENDING_REFERENCE'`);
    this.addSql(`
      create index ix_wager_tx_awaiting_reference on wager_transactions (provider_id, reference_external_transaction_id)
        where status = 'PENDING_REFERENCE'`);

    this.addSql(`
      create function wager_transactions_guard() returns trigger language plpgsql as $$
      begin
        if tg_op = 'DELETE' then
          raise exception 'wager_transactions: DELETE não é permitido (transação %)', old.id
            using errcode = '23001';
        end if;
        if old.status in ('PROCESSED','REJECTED','FAILED') then
          raise exception 'wager_transactions: transação % está em estado terminal (%) e não pode mudar', old.id, old.status
            using errcode = '23001';
        end if;
        if (new.id, new.provider_id, new.external_transaction_id, new.idempotency_key, new.payload_hash,
            new.wallet_id, new.player_id, new.round_id, new.game_id, new.kind, new.amount, new.currency,
            new.reference_external_transaction_id, new.created_at)
           is distinct from
           (old.id, old.provider_id, old.external_transaction_id, old.idempotency_key, old.payload_hash,
            old.wallet_id, old.player_id, old.round_id, old.game_id, old.kind, old.amount, old.currency,
            old.reference_external_transaction_id, old.created_at) then
          raise exception 'wager_transactions: identidade e payload da transação % são imutáveis', old.id
            using errcode = '23001';
        end if;
        return new;
      end
      $$`);
    this.addSql(`
      create trigger trg_wager_transactions_guard before update or delete on wager_transactions
        for each row execute function wager_transactions_guard()`);

    this.addSql(`
      create table wallet_ledger_entries (
        id uuid primary key,
        -- cursor estável da paginação do ledger
        seq bigint generated always as identity,
        wallet_id uuid not null,
        transaction_id uuid not null,
        direction text not null,
        amount numeric(20,2) not null,
        currency char(3) not null,
        balance_before numeric(20,2) not null,
        balance_after numeric(20,2) not null,
        created_at timestamptz not null,
        constraint ck_ledger_direction check (direction in ('DEBIT','CREDIT')),
        constraint ck_ledger_amount_positive check (amount > 0),
        constraint ck_ledger_balance_before check (balance_before >= 0),
        constraint ck_ledger_balance_after check (balance_after >= 0),
        constraint ck_ledger_arithmetic check (
          (direction = 'CREDIT' and balance_after = balance_before + amount)
          or (direction = 'DEBIT' and balance_after = balance_before - amount)
        ),
        constraint uq_ledger_wallet_transaction unique (wallet_id, transaction_id),
        -- índice da paginação por cursor
        constraint uq_ledger_wallet_seq unique (wallet_id, seq),
        constraint fk_ledger_wallet_currency foreign key (wallet_id, currency)
          references wallets (id, currency) deferrable initially deferred,
        constraint fk_ledger_transaction foreign key (transaction_id, wallet_id)
          references wager_transactions (id, wallet_id) deferrable initially deferred
      )`);

    this.addSql(`
      create function wallet_ledger_entries_append_only() returns trigger language plpgsql as $$
      begin
        raise exception 'wallet_ledger_entries é append-only: % não é permitido', tg_op
          using errcode = '23001';
      end
      $$`);
    this.addSql(`
      create trigger trg_ledger_append_only before update or delete on wallet_ledger_entries
        for each row execute function wallet_ledger_entries_append_only()`);

    // Saldo × ledger, checado no COMMIT: o saldo da wallet tem de ser o balance_after do último
    // lançamento (ou 0 sem lançamentos). Dispara quando o saldo muda e quando entra um lançamento,
    // cobrindo os dois sentidos ("toda alteração de saldo tem lançamento, e vice-versa").
    this.addSql(`
      create function wallet_balance_matches_ledger() returns trigger language plpgsql as $$
      declare
        target_wallet uuid;
        stored numeric(20,2);
        last_after numeric(20,2);
      begin
        if tg_table_name = 'wallets' then
          target_wallet := new.id;
        else
          target_wallet := new.wallet_id;
        end if;
        select balance into stored from wallets where id = target_wallet;
        if not found then
          return null; -- wallet inexistente é problema da FK
        end if;
        select balance_after into last_after from wallet_ledger_entries
          where wallet_id = target_wallet order by seq desc limit 1;
        if stored <> coalesce(last_after, 0) then
          raise exception 'wallet %: saldo % diverge do último lançamento (%)', target_wallet, stored, coalesce(last_after::text, 'nenhum')
            using errcode = '23514';
        end if;
        return null;
      end
      $$`);
    this.addSql(`
      create constraint trigger trg_wallets_balance_matches_ledger after insert or update of balance on wallets
        deferrable initially deferred for each row execute function wallet_balance_matches_ledger()`);
    this.addSql(`
      create constraint trigger trg_ledger_balance_matches_wallet after insert on wallet_ledger_entries
        deferrable initially deferred for each row execute function wallet_balance_matches_ledger()`);

    this.addSql(`
      create table inbox_messages (
        consumer_name text not null,
        message_id text not null,
        payload_hash text not null,
        received_at timestamptz not null,
        processed_at timestamptz,
        constraint pk_inbox_messages primary key (consumer_name, message_id)
      )`);

    this.addSql(`
      create table outbox_messages (
        id uuid primary key,
        aggregate_id uuid not null,
        event_type text not null,
        payload jsonb not null,
        occurred_at timestamptz not null,
        attempts integer not null default 0,
        next_attempt_at timestamptz,
        published_at timestamptz,
        constraint ck_outbox_attempts check (attempts >= 0)
      )`);
    this.addSql(`
      create index ix_outbox_pending on outbox_messages (next_attempt_at) where published_at is null`);
  }

  override async down(): Promise<void> {
    this.addSql('drop table outbox_messages');
    this.addSql('drop table inbox_messages');
    this.addSql('drop table wallet_ledger_entries');
    this.addSql('drop table wager_transactions');
    this.addSql('drop table wallets');
    this.addSql('drop function wallet_balance_matches_ledger()');
    this.addSql('drop function wallet_ledger_entries_append_only()');
    this.addSql('drop function wager_transactions_guard()');
  }
}
