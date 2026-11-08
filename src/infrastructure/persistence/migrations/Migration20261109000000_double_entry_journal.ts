import { Migration } from '@mikro-orm/migrations';

/**
 * Diário de partidas dobradas, paralelo e aditivo ao `wallet_ledger_entries` (que não muda).
 * ARCHITECTURE.md → "Diário de partidas dobradas".
 *
 * - `accounts`: PLAYER (uma por wallet), PROVIDER_HOUSE (uma por provider e moeda), FUNDING (uma por moeda).
 *   Sem saldo materializado: a HOUSE não vira hot row; saldo é soma sob demanda.
 * - `journal_entries`: um lançamento por transação que move saldo. `journal_postings`: as pernas.
 * - Uma moeda por lançamento pela FK (journal_entry_id, currency); moeda da conta pela FK (account_id, currency).
 * - Constraint trigger deferido `trg_journal_balanced`: no COMMIT, débitos = créditos, transação PROCESSED
 *   que move saldo, contas certas e perna PLAYER igual ao lançamento da wallet. Só LÊ o ledger.
 * - As três tabelas são append-only (23001). Violação do balanço: 23514 com constraint `trg_journal_balanced`.
 * - FUNDING criadas aqui para BRL, USD e as moedas já existentes; moeda nova cria a sua sob demanda.
 * - Backfill a partir de `wallet_ledger_entries`, validado pelo próprio trigger no COMMIT da migration.
 */
export class Migration20261109000000_double_entry_journal extends Migration {
  override async up(): Promise<void> {
    this.addSql(`
      create table accounts (
        id uuid primary key,
        kind text not null,
        wallet_id uuid,
        provider_id text,
        currency char(3) not null,
        created_at timestamptz not null,
        constraint ck_accounts_kind check (kind in ('PLAYER','PROVIDER_HOUSE','FUNDING')),
        constraint ck_accounts_currency check (currency ~ '^[A-Z]{3}$'),
        constraint ck_accounts_owner check (
          (kind = 'PLAYER' and wallet_id is not null and provider_id is null)
          or (kind = 'PROVIDER_HOUSE' and wallet_id is null and provider_id is not null)
          or (kind = 'FUNDING' and wallet_id is null and provider_id is null)
        ),
        -- alvo da FK (account_id, currency) das pernas
        constraint uq_accounts_id_currency unique (id, currency),
        constraint fk_accounts_wallet_currency foreign key (wallet_id, currency)
          references wallets (id, currency) deferrable initially deferred
      )`);
    this.addSql(`create unique index ux_accounts_player on accounts (wallet_id) where kind = 'PLAYER'`);
    this.addSql(`create unique index ux_accounts_house on accounts (provider_id, currency) where kind = 'PROVIDER_HOUSE'`);
    this.addSql(`create unique index ux_accounts_funding on accounts (currency) where kind = 'FUNDING'`);

    this.addSql(`
      create table journal_entries (
        id uuid primary key,
        wager_transaction_id uuid not null,
        currency char(3) not null,
        created_at timestamptz not null,
        constraint uq_journal_wager_tx unique (wager_transaction_id),
        -- alvo da FK (journal_entry_id, currency) das pernas: uma moeda por lançamento
        constraint uq_journal_id_currency unique (id, currency),
        constraint fk_journal_wager_tx foreign key (wager_transaction_id)
          references wager_transactions (id) deferrable initially deferred
      )`);

    this.addSql(`
      create table journal_postings (
        id uuid primary key,
        journal_entry_id uuid not null,
        account_id uuid not null,
        direction text not null,
        amount numeric(20,2) not null,
        currency char(3) not null,
        constraint ck_postings_direction check (direction in ('DEBIT','CREDIT')),
        constraint ck_postings_amount_positive check (amount > 0),
        constraint fk_postings_entry_currency foreign key (journal_entry_id, currency)
          references journal_entries (id, currency) deferrable initially deferred,
        constraint fk_postings_account_currency foreign key (account_id, currency)
          references accounts (id, currency) deferrable initially deferred
      )`);
    this.addSql(`create index ix_postings_entry on journal_postings (journal_entry_id)`);
    this.addSql(`create index ix_postings_account on journal_postings (account_id)`);

    this.addSql(`
      create function journal_append_only() returns trigger language plpgsql as $$
      begin
        raise exception '% é append-only: % não é permitido', tg_table_name, tg_op
          using errcode = '23001';
      end
      $$`);
    for (const table of ['accounts', 'journal_entries', 'journal_postings']) {
      this.addSql(`
        create trigger trg_${table}_append_only before update or delete on ${table}
          for each row execute function journal_append_only()`);
    }

    // Checado no COMMIT, para o lançamento inserido ou para o lançamento da perna inserida (uma perna
    // avulsa num lançamento antigo também é pega).
    this.addSql(`
      create function journal_entry_balanced() returns trigger language plpgsql as $$
      declare
        target uuid;
        entry record;
        tx record;
        legs integer;
        debits numeric(20,2);
        credits numeric(20,2);
        player_legs integer;
        player_direction text;
        player_amount numeric(20,2);
        wrong_accounts integer;
        ledger record;
      begin
        if tg_table_name = 'journal_entries' then
          target := new.id;
        else
          target := new.journal_entry_id;
        end if;
        select * into entry from journal_entries where id = target;
        if not found then
          return null; -- lançamento inexistente é problema da FK
        end if;

        select count(*),
               coalesce(sum(amount) filter (where direction = 'DEBIT'), 0),
               coalesce(sum(amount) filter (where direction = 'CREDIT'), 0)
          into legs, debits, credits
          from journal_postings where journal_entry_id = target;
        if legs < 2 or debits = 0 or credits = 0 or debits <> credits then
          raise exception 'diário %: débitos (%) e créditos (%) não fecham em % pernas', target, debits, credits, legs
            using errcode = '23514', constraint = 'trg_journal_balanced';
        end if;

        select kind, status, amount, currency, wallet_id, provider_id into tx
          from wager_transactions where id = entry.wager_transaction_id;
        if not found then
          return null; -- transação inexistente é problema da FK
        end if;
        if tx.status <> 'PROCESSED' or tx.kind = 'LOSS' or tx.currency <> entry.currency or tx.amount <> debits then
          raise exception 'diário %: transação % não é PROCESSED que move saldo com o mesmo valor e moeda', target, entry.wager_transaction_id
            using errcode = '23514', constraint = 'trg_journal_balanced';
        end if;

        select count(*) filter (where a.kind = 'PLAYER'),
               min(p.direction) filter (where a.kind = 'PLAYER'),
               min(p.amount) filter (where a.kind = 'PLAYER'),
               count(*) filter (where not (
                 (a.kind = 'PLAYER' and a.wallet_id = tx.wallet_id)
                 or (tx.kind = 'OPENING' and a.kind = 'FUNDING')
                 or (tx.kind <> 'OPENING' and a.kind = 'PROVIDER_HOUSE' and a.provider_id = tx.provider_id)
               ))
          into player_legs, player_direction, player_amount, wrong_accounts
          from journal_postings p join accounts a on a.id = p.account_id
         where p.journal_entry_id = target;
        if player_legs <> 1 or wrong_accounts <> 0 then
          raise exception 'diário %: exige uma perna PLAYER da wallet e contrapartida FUNDING (OPENING) ou PROVIDER_HOUSE do provider', target
            using errcode = '23514', constraint = 'trg_journal_balanced';
        end if;

        select direction, amount into ledger from wallet_ledger_entries
         where wallet_id = tx.wallet_id and transaction_id = entry.wager_transaction_id;
        if not found or ledger.direction <> player_direction or ledger.amount <> player_amount then
          raise exception 'diário %: perna PLAYER diverge do lançamento da wallet', target
            using errcode = '23514', constraint = 'trg_journal_balanced';
        end if;
        return null;
      end
      $$`);
    this.addSql(`
      create constraint trigger trg_journal_entries_balanced after insert on journal_entries
        deferrable initially deferred for each row execute function journal_entry_balanced()`);
    this.addSql(`
      create constraint trigger trg_journal_postings_balanced after insert on journal_postings
        deferrable initially deferred for each row execute function journal_entry_balanced()`);

    // FUNDING por moeda (BRL, USD e as já usadas); as demais nascem sob demanda.
    this.addSql(`
      insert into accounts (id, kind, currency, created_at)
      select gen_random_uuid(), 'FUNDING', currency, now()
        from (select 'BRL'::char(3) as currency union select 'USD' union select currency from wallets) as currencies`);

    // Backfill a partir do ledger atual. Contas PLAYER só para wallets com lançamento (como no código).
    this.addSql(`
      insert into accounts (id, kind, wallet_id, currency, created_at)
      select gen_random_uuid(), 'PLAYER', w.id, w.currency, w.created_at
        from wallets w
       where exists (select 1 from wallet_ledger_entries l where l.wallet_id = w.id)`);
    this.addSql(`
      insert into accounts (id, kind, provider_id, currency, created_at)
      select gen_random_uuid(), 'PROVIDER_HOUSE', provider_id, currency, now()
        from (select distinct t.provider_id, t.currency
                from wallet_ledger_entries l join wager_transactions t on t.id = l.transaction_id
               where t.kind <> 'OPENING') as houses`);
    this.addSql(`
      insert into journal_entries (id, wager_transaction_id, currency, created_at)
      select gen_random_uuid(), transaction_id, currency, created_at from wallet_ledger_entries`);
    this.addSql(`
      insert into journal_postings (id, journal_entry_id, account_id, direction, amount, currency)
      select gen_random_uuid(), j.id, a.id, l.direction, l.amount, l.currency
        from wallet_ledger_entries l
        join journal_entries j on j.wager_transaction_id = l.transaction_id
        join accounts a on a.kind = 'PLAYER' and a.wallet_id = l.wallet_id
      union all
      select gen_random_uuid(), j.id, a.id,
             case l.direction when 'DEBIT' then 'CREDIT' else 'DEBIT' end, l.amount, l.currency
        from wallet_ledger_entries l
        join journal_entries j on j.wager_transaction_id = l.transaction_id
        join wager_transactions t on t.id = l.transaction_id
        join accounts a on a.currency = l.currency and (
          (t.kind = 'OPENING' and a.kind = 'FUNDING')
          or (t.kind <> 'OPENING' and a.kind = 'PROVIDER_HOUSE' and a.provider_id = t.provider_id)
        )`);
  }

  override async down(): Promise<void> {
    this.addSql('drop table journal_postings');
    this.addSql('drop table journal_entries');
    this.addSql('drop table accounts');
    this.addSql('drop function journal_entry_balanced()');
    this.addSql('drop function journal_append_only()');
  }
}
