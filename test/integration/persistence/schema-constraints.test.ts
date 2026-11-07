import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import type { MikroORM } from '@mikro-orm/postgresql';
import { randomUUID } from 'node:crypto';
import {
  PG,
  T0,
  expectPgError,
  ledgerRow,
  openOrm,
  processed,
  seedWallet,
  transactionRow,
  truncateAll,
  walletRow,
} from './db';

/** Cada garantia do schema provada contra o Postgres real: o banco rejeita a violação. */
describe('schema — constraints e triggers', () => {
  let orm: MikroORM;
  const db = () => orm.em.getKnex();

  beforeAll(async () => {
    orm = await openOrm();
  });

  beforeEach(async () => {
    await truncateAll(orm);
  });

  afterAll(async () => {
    await orm.close(true);
  });

  describe('wallets', () => {
    it('rejeita saldo negativo', async () => {
      await expectPgError(
        db()('wallets').insert(walletRow({ balance: '-0.01' })),
        PG.checkViolation,
        'ck_wallets_balance_non_negative',
      );
    });

    it('rejeita UPDATE que deixaria o saldo negativo', async () => {
      const { walletId } = await seedWallet(orm, '10.00');
      await expectPgError(
        db()('wallets').where({ id: walletId }).update({ balance: '-1.00' }),
        PG.checkViolation,
        'ck_wallets_balance_non_negative',
      );
    });

    it('rejeita segunda wallet para o mesmo player e moeda', async () => {
      const first = walletRow();
      await db()('wallets').insert(first);
      await expectPgError(
        db()('wallets').insert(walletRow({ player_id: first.player_id })),
        PG.uniqueViolation,
        'uq_wallets_player_currency',
      );
      // Outra moeda para o mesmo player é permitida.
      await db()('wallets').insert(walletRow({ player_id: first.player_id, currency: 'USD' }));
    });

    it('rejeita version < 1 e moeda fora do formato ISO', async () => {
      await expectPgError(db()('wallets').insert(walletRow({ version: 0 })), PG.checkViolation, 'ck_wallets_version');
      await expectPgError(db()('wallets').insert(walletRow({ currency: 'brl' })), PG.checkViolation, 'ck_wallets_currency');
    });
  });

  describe('saldo × ledger (constraint trigger no COMMIT)', () => {
    it('rejeita wallet aberta com saldo sem lançamento', async () => {
      await expectPgError(db()('wallets').insert(walletRow({ balance: '50.00' })), PG.checkViolation);
    });

    it('rejeita alteração de saldo sem lançamento correspondente', async () => {
      const { walletId } = await seedWallet(orm, '100.00');
      await expectPgError(
        db()('wallets').where({ id: walletId }).update({ balance: '90.00', version: 2 }),
        PG.checkViolation,
      );
    });

    it('rejeita lançamento sem a alteração de saldo correspondente', async () => {
      const { walletId } = await seedWallet(orm, '100.00');
      const win = processed({ wallet_id: walletId, kind: 'WIN', observed_balance: '110.00' });
      await expectPgError(
        db().transaction(async (trx) => {
          await trx('wager_transactions').insert(win);
          await trx('wallet_ledger_entries').insert(
            ledgerRow({ wallet_id: walletId, transaction_id: win.id as string, balance_before: '100.00', balance_after: '110.00' }),
          );
        }),
        PG.checkViolation,
      );
    });

    it('aceita saldo e lançamento gravados juntos, em qualquer ordem', async () => {
      const { walletId } = await seedWallet(orm, '100.00');
      const bet = processed({ wallet_id: walletId, observed_balance: '90.00' });
      await db().transaction(async (trx) => {
        // lançamento antes da transação e da wallet: as FKs e o trigger são deferidos
        await trx('wallet_ledger_entries').insert(
          ledgerRow({
            wallet_id: walletId,
            transaction_id: bet.id as string,
            direction: 'DEBIT',
            balance_before: '100.00',
            balance_after: '90.00',
          }),
        );
        await trx('wager_transactions').insert(bet);
        await trx('wallets').where({ id: walletId }).update({ balance: '90.00', version: 2 });
      });
      const [wallet] = await db()('wallets').where({ id: walletId }).select(db().raw('balance::text as balance'));
      expect(wallet.balance).toBe('90.00');
    });
  });

  describe('wager_transactions', () => {
    let walletId: string;

    beforeEach(async () => {
      ({ walletId } = await seedWallet(orm, '100.00'));
    });

    it('rejeita idempotency_key duplicada', async () => {
      const first = transactionRow({ wallet_id: walletId });
      await db()('wager_transactions').insert(first);
      await expectPgError(
        db()('wager_transactions').insert(transactionRow({ wallet_id: walletId, idempotency_key: first.idempotency_key })),
        PG.uniqueViolation,
        'uq_wager_tx_idempotency_key',
      );
    });

    it('rejeita (provider_id, external_transaction_id) duplicado', async () => {
      const first = transactionRow({ wallet_id: walletId });
      await db()('wager_transactions').insert(first);
      await expectPgError(
        db()('wager_transactions').insert(
          transactionRow({ wallet_id: walletId, external_transaction_id: first.external_transaction_id }),
        ),
        PG.uniqueViolation,
        'uq_wager_tx_provider_external',
      );
    });

    it.each([
      ['kind inválido', { kind: 'CASHOUT' }, 'ck_wager_tx_kind'],
      ['status inválido', { status: 'DONE' }, 'ck_wager_tx_status'],
      ['valor negativo', { kind: 'LOSS', amount: '-1.00' }, 'ck_wager_tx_amount'],
      ['BET com valor zero', { kind: 'BET', amount: '0.00' }, 'ck_wager_tx_amount'],
      ['REFUND sem referência', { kind: 'REFUND' }, 'ck_wager_tx_reference_required'],
      ['ROLLBACK sem referência', { kind: 'ROLLBACK' }, 'ck_wager_tx_reference_required'],
      ['PROCESSED sem processed_at', { status: 'PROCESSED', observed_balance: '1.00' }, 'ck_wager_tx_processed'],
      ['PROCESSED sem saldo observado', { status: 'PROCESSED', processed_at: T0 }, 'ck_wager_tx_processed_balance'],
      [
        'REFUND PROCESSED sem referência interna',
        { kind: 'REFUND', reference_external_transaction_id: 'x', status: 'PROCESSED', processed_at: T0, observed_balance: '1.00' },
        'ck_wager_tx_processed_reference',
      ],
      ['REJECTED sem failure_code', { status: 'REJECTED' }, 'ck_wager_tx_failure'],
      ['failure_code fora da taxonomia', { status: 'REJECTED', failure_code: 'NOPE' }, 'ck_wager_tx_failure_code'],
      ['failure_code em PENDING', { failure_code: 'AMOUNT_MISMATCH' }, 'ck_wager_tx_failure'],
      [
        'PENDING_REFERENCE sem agendamento',
        { kind: 'REFUND', reference_external_transaction_id: 'x', status: 'PENDING_REFERENCE' },
        'ck_wager_tx_pending_reference',
      ],
      ['saldo observado negativo', { observed_balance: '-1.00' }, 'ck_wager_tx_observed_balance'],
    ])('CHECK: rejeita %s', async (_name, overrides, constraint) => {
      await expectPgError(
        db()('wager_transactions').insert(transactionRow({ wallet_id: walletId, ...overrides })),
        PG.checkViolation,
        constraint,
      );
    });

    it('aceita LOSS com valor zero', async () => {
      await db()('wager_transactions').insert(transactionRow({ wallet_id: walletId, kind: 'LOSS', amount: '0.00' }));
    });

    it('rejeita moeda diferente da wallet em transação não rejeitada', async () => {
      await expectPgError(
        db()('wager_transactions').insert(transactionRow({ wallet_id: walletId, currency: 'USD' })),
        PG.foreignKeyViolation,
        'fk_wager_tx_wallet_currency',
      );
    });

    it('rejeita transação de wallet inexistente', async () => {
      await expectPgError(
        db()('wager_transactions').insert(transactionRow({ wallet_id: randomUUID() })),
        PG.foreignKeyViolation,
        'fk_wager_tx_wallet_currency',
      );
    });

    it('aceita REJECTED por CURRENCY_MISMATCH e WALLET_NOT_FOUND (auditáveis)', async () => {
      await db()('wager_transactions').insert([
        transactionRow({ wallet_id: walletId, currency: 'USD', status: 'REJECTED', failure_code: 'CURRENCY_MISMATCH' }),
        transactionRow({ wallet_id: randomUUID(), status: 'REJECTED', failure_code: 'WALLET_NOT_FOUND' }),
      ]);
    });

    it('rejeita referência interna de outra wallet', async () => {
      const other = await seedWallet(orm, '5.00');
      const bet = processed({ wallet_id: other.walletId });
      await db()('wager_transactions').insert(bet);
      await expectPgError(
        db()('wager_transactions').insert(
          processed({
            wallet_id: walletId,
            kind: 'REFUND',
            reference_external_transaction_id: bet.external_transaction_id,
            reference_transaction_id: bet.id,
          }),
        ),
        PG.foreignKeyViolation,
        'fk_wager_tx_reference',
      );
    });

    it('aceita REJECTED por REFERENCE_WALLET_MISMATCH guardando só a referência externa', async () => {
      const other = await seedWallet(orm, '5.00');
      const bet = processed({ wallet_id: other.walletId });
      await db()('wager_transactions').insert(bet);
      await db()('wager_transactions').insert(
        transactionRow({
          wallet_id: walletId,
          kind: 'REFUND',
          reference_external_transaction_id: bet.external_transaction_id,
          status: 'REJECTED',
          failure_code: 'REFERENCE_WALLET_MISMATCH',
        }),
      );
    });

    describe('uma reversão PROCESSED por referência e por tipo', () => {
      const reversal = (bet: Record<string, unknown>, kind: string, overrides: Record<string, unknown> = {}) =>
        processed({
          wallet_id: walletId,
          kind,
          reference_external_transaction_id: bet.external_transaction_id,
          reference_transaction_id: bet.id,
          ...overrides,
        });

      it.each(['REFUND', 'ROLLBACK'])('rejeita segundo %s PROCESSED da mesma referência', async (kind) => {
        const bet = processed({ wallet_id: walletId });
        await db()('wager_transactions').insert([bet, reversal(bet, kind)]);
        await expectPgError(
          db()('wager_transactions').insert(reversal(bet, kind)),
          PG.uniqueViolation,
          'ux_wager_tx_one_reversal_per_kind',
        );
      });

      it('aceita REFUND e ROLLBACK da mesma referência, e reversões rejeitadas repetidas', async () => {
        const bet = processed({ wallet_id: walletId });
        const rejected = { status: 'REJECTED', processed_at: null, observed_balance: null, failure_code: 'REFERENCE_ALREADY_REVERSED' };
        await db()('wager_transactions').insert([
          bet,
          reversal(bet, 'REFUND'),
          reversal(bet, 'ROLLBACK'),
          reversal(bet, 'REFUND', rejected),
          reversal(bet, 'REFUND', rejected),
        ]);
      });
    });

    describe('trigger de imutabilidade', () => {
      it.each([
        ['PROCESSED', { status: 'PROCESSED', processed_at: T0, observed_balance: '90.00' }],
        ['REJECTED', { status: 'REJECTED', failure_code: 'INSUFFICIENT_BALANCE' }],
        ['FAILED', { status: 'FAILED', failure_code: 'INFRASTRUCTURE_FAILURE' }],
      ])('transação %s não pode mudar', async (_status, terminal) => {
        const tx = transactionRow({ wallet_id: walletId, ...terminal });
        await db()('wager_transactions').insert(tx);
        await expectPgError(
          db()('wager_transactions').where({ id: tx.id }).update({ status: 'PENDING', processed_at: null, observed_balance: null, failure_code: null }),
          PG.restrictViolation,
        );
        await expectPgError(
          db()('wager_transactions').where({ id: tx.id }).update({ reference_attempts: 1 }),
          PG.restrictViolation,
        );
      });

      it.each([
        ['amount', '20.00'],
        ['currency', 'USD'],
        ['kind', 'WIN'],
        ['idempotency_key', 'other-key'],
        ['payload_hash', 'other-hash'],
        ['external_transaction_id', 'other-ext'],
        ['provider_id', 'other-provider'],
        ['wallet_id', randomUUID()],
        ['player_id', 'other-player'],
        ['round_id', 'other-round'],
      ])('%s nunca muda, mesmo em PENDING', async (column, value) => {
        const tx = transactionRow({ wallet_id: walletId });
        await db()('wager_transactions').insert(tx);
        await expectPgError(db()('wager_transactions').where({ id: tx.id }).update({ [column]: value }), PG.restrictViolation);
      });

      it('permite as transições de status a partir de PENDING', async () => {
        const tx = transactionRow({ wallet_id: walletId });
        await db()('wager_transactions').insert(tx);
        await db()('wager_transactions')
          .where({ id: tx.id })
          .update({ status: 'PROCESSED', processed_at: T0, observed_balance: '100.00' });
      });

      it('DELETE é sempre bloqueado, inclusive em PENDING', async () => {
        const tx = transactionRow({ wallet_id: walletId });
        await db()('wager_transactions').insert(tx);
        await expectPgError(db()('wager_transactions').where({ id: tx.id }).delete(), PG.restrictViolation);
      });
    });
  });

  describe('wallet_ledger_entries', () => {
    let walletId: string;
    let openingId: string;

    beforeEach(async () => {
      ({ walletId, openingId } = await seedWallet(orm, '100.00'));
    });

    /** Grava uma transação PROCESSED e o lançamento dela, já atualizando o saldo da wallet. */
    const credit = async (amount: string, entry: Record<string, unknown> = {}) => {
      const win = processed({ wallet_id: walletId, kind: 'WIN', amount });
      await db().transaction(async (trx) => {
        await trx('wager_transactions').insert(win);
        await trx('wallets').where({ id: walletId }).update({ balance: entry.balance_after ?? '100.00' });
        await trx('wallet_ledger_entries').insert(
          ledgerRow({ wallet_id: walletId, transaction_id: win.id as string, amount, balance_before: '100.00', ...entry }),
        );
      });
    };

    it('rejeita segundo lançamento da mesma transação na mesma wallet', async () => {
      await expectPgError(
        db()('wallet_ledger_entries').insert(
          ledgerRow({ wallet_id: walletId, transaction_id: openingId, balance_before: '100.00', balance_after: '110.00' }),
        ),
        PG.uniqueViolation,
        'uq_ledger_wallet_transaction',
      );
    });

    it.each([
      ['CREDIT com aritmética errada', { direction: 'CREDIT', balance_after: '109.99' }],
      ['DEBIT somando em vez de subtrair', { direction: 'DEBIT', balance_after: '110.00' }],
    ])('rejeita %s', async (_name, entry) => {
      await expectPgError(credit('10.00', entry), PG.checkViolation, 'ck_ledger_arithmetic');
    });

    it.each([
      ['valor zero', { amount: '0.00', balance_after: '100.00' }, 'ck_ledger_amount_positive'],
      ['saldo final negativo', { direction: 'DEBIT', amount: '10.00', balance_before: '5.00', balance_after: '-5.00' }, 'ck_ledger_balance_after'],
      // Sem constraint específica: ck_ledger_arithmetic também falha (ela só admite CREDIT/DEBIT).
      ['direção inválida', { direction: 'SIDEWAYS' }, undefined],
    ])('rejeita %s', async (_name, entry, constraint) => {
      await expectPgError(
        db()('wallet_ledger_entries').insert(ledgerRow({ wallet_id: walletId, transaction_id: openingId, ...entry })),
        PG.checkViolation,
        constraint,
      );
    });

    it('rejeita lançamento em moeda diferente da wallet', async () => {
      await expectPgError(
        credit('10.00', { currency: 'USD', balance_after: '110.00' }),
        PG.foreignKeyViolation,
        'fk_ledger_wallet_currency',
      );
    });

    it('rejeita lançamento de transação de outra wallet', async () => {
      const other = await seedWallet(orm, '5.00');
      await expectPgError(
        credit('10.00', { transaction_id: other.openingId, balance_after: '110.00' }),
        PG.foreignKeyViolation,
        'fk_ledger_transaction',
      );
    });

    it('UPDATE é bloqueado (append-only)', async () => {
      await expectPgError(
        db()('wallet_ledger_entries').where({ transaction_id: openingId }).update({ created_at: new Date() }),
        PG.restrictViolation,
      );
    });

    it('DELETE é bloqueado (append-only)', async () => {
      await expectPgError(db()('wallet_ledger_entries').where({ transaction_id: openingId }).delete(), PG.restrictViolation);
    });

    it('seq cresce na ordem de inserção (cursor estável)', async () => {
      await credit('10.00', { balance_after: '110.00' });
      const rows = await db()('wallet_ledger_entries').where({ wallet_id: walletId }).orderBy('seq').select('transaction_id');
      expect(rows.map((row: { transaction_id: string }) => row.transaction_id)[0]).toBe(openingId);
      expect(rows).toHaveLength(2);
    });
  });

  describe('inbox e outbox', () => {
    it('rejeita mensagem duplicada para o mesmo consumidor', async () => {
      const message = { consumer_name: 'wager-consumer', message_id: 'm-1', payload_hash: 'h', received_at: T0 };
      await db()('inbox_messages').insert(message);
      await expectPgError(db()('inbox_messages').insert(message), PG.uniqueViolation, 'pk_inbox_messages');
      // Outro consumidor pode receber a mesma mensagem.
      await db()('inbox_messages').insert({ ...message, consumer_name: 'other-consumer' });
    });

    it('rejeita attempts negativo na outbox', async () => {
      await expectPgError(
        db()('outbox_messages').insert({
          id: randomUUID(),
          aggregate_id: randomUUID(),
          event_type: 'x',
          payload: {},
          occurred_at: T0,
          attempts: -1,
        }),
        PG.checkViolation,
        'ck_outbox_attempts',
      );
    });
  });
});
