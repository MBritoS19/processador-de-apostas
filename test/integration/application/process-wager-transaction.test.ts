import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import type { MikroORM } from '@mikro-orm/postgresql';
import { randomUUID } from 'node:crypto';
import type {
  ProcessWagerTransactionCommand,
  ProcessWagerTransactionResult,
} from '../../../src/application/wagering/process-wager-transaction';
import { WalletVersionConflictError } from '../../../src/application/ports/wager-unit-of-work';
import { FailureCode } from '../../../src/domain/failure-code';
import { Money } from '../../../src/domain/money';
import { Wallet } from '../../../src/domain/wallet';
import { MikroOrmWagerUnitOfWork } from '../../../src/infrastructure/persistence/mikro-orm-wager-unit-of-work';
import { T0, expectLedgerConsistent, openOrm, seedWallet, truncateAll } from '../persistence/db';
import { buildUseCase, command, countRows, walletBalance, type WalletRef } from './harness';

describe('ProcessWagerTransaction (Postgres real)', () => {
  let orm: MikroORM;
  let wallet: WalletRef;
  let useCase: ReturnType<typeof buildUseCase>['useCase'];

  beforeAll(async () => {
    orm = await openOrm();
  });

  beforeEach(async () => {
    await truncateAll(orm);
    wallet = await seedWallet(orm, '100.00');
    ({ useCase } = buildUseCase(orm));
  });

  afterEach(async () => {
    await expectLedgerConsistent(orm, wallet.walletId);
  });

  afterAll(async () => {
    await orm.close(true);
  });

  const run = (cmd: ProcessWagerTransactionCommand) => useCase.execute(cmd);

  async function expectType<T extends ProcessWagerTransactionResult['type']>(
    cmd: ProcessWagerTransactionCommand,
    type: T,
  ): Promise<Extract<ProcessWagerTransactionResult, { type: T }>> {
    const result = await run(cmd);
    expect(result.type).toBe(type);
    return result as Extract<ProcessWagerTransactionResult, { type: T }>;
  }

  const txRow = async (id: string) => (await orm.em.getKnex()('wager_transactions').where({ id }))[0];
  const outbox = async (aggregateId?: string) =>
    (await orm.em.getKnex()('outbox_messages').where(aggregateId ? { aggregate_id: aggregateId } : {}).orderBy('event_type'))
      .map((row) => row.payload as Record<string, unknown> & { eventType: string; data: Record<string, unknown> });

  /** Processa e devolve o id externo, para servir de referência. */
  async function processedTx(payload: Parameters<typeof command>[1]) {
    const cmd = command(wallet, payload);
    const result = await expectType(cmd, 'Processed');
    return { id: result.transactionId, external: cmd.payload.externalTransactionId as string, result };
  }

  describe('BET', () => {
    it('debita, grava lançamento DEBIT e eventos Processed + WalletBalanceChanged na outbox', async () => {
      const result = await expectType(command(wallet, { money: { amount: '25.00', currency: 'BRL' } }), 'Processed');

      expect(result).toMatchObject({ balance: { amount: '75.00', currency: 'BRL' }, idempotentReplay: false });
      expect(await walletBalance(orm, wallet.walletId)).toBe('75.00');
      const entries = await orm.em.getKnex()('wallet_ledger_entries').where({ transaction_id: result.transactionId });
      expect(entries).toHaveLength(1);
      expect(entries[0]).toMatchObject({ direction: 'DEBIT', amount: '25.00', balance_before: '100.00', balance_after: '75.00' });
      expect(await txRow(result.transactionId)).toMatchObject({ status: 'PROCESSED', observed_balance: '75.00' });

      const events = await outbox();
      expect(events.map((e) => e.eventType)).toEqual(['WagerTransactionProcessed', 'WalletBalanceChanged']);
      const [processed, changed] = events;
      expect(processed).toMatchObject({ correlationId: 'corr-1', aggregateId: result.transactionId });
      expect(processed?.causationId).toStartWith('provider-a:');
      expect(changed).toMatchObject({ correlationId: 'corr-1', causationId: processed?.eventId, aggregateId: wallet.walletId });
      expect(changed?.data).toMatchObject({ balanceBefore: { amount: '100.00' }, balanceAfter: { amount: '75.00' }, walletVersion: 2 });
    });

    it('saldo insuficiente → REJECTED com INSUFFICIENT_BALANCE, sem lançamento, auditável', async () => {
      const result = await expectType(command(wallet, { money: { amount: '100.01', currency: 'BRL' } }), 'Rejected');

      expect(result).toMatchObject({ failureCode: 'INSUFFICIENT_BALANCE', balance: { amount: '100.00' } });
      expect(await walletBalance(orm, wallet.walletId)).toBe('100.00');
      expect(await txRow(result.transactionId)).toMatchObject({ status: 'REJECTED', failure_code: 'INSUFFICIENT_BALANCE' });
      expect(await countRows(orm, 'wallet_ledger_entries', { transaction_id: result.transactionId })).toBe(0);
      expect((await outbox()).map((e) => e.eventType)).toEqual(['WagerTransactionRejected']);
    });

    it('saldo exato é aceito (100.00 → 0.00)', async () => {
      const result = await expectType(command(wallet, { money: { amount: '100.00', currency: 'BRL' } }), 'Processed');
      expect(result.balance.amount).toBe('0.00');
    });
  });

  describe('WIN', () => {
    it('sem referência: credita', async () => {
      const result = await expectType(command(wallet, { kind: 'WIN', money: { amount: '50.00', currency: 'BRL' } }), 'Processed');
      expect(result.balance.amount).toBe('150.00');
    });

    it('com referência à BET da rodada: credita e guarda o id interno da referência', async () => {
      const bet = await processedTx({});
      const result = await expectType(
        command(wallet, { kind: 'WIN', referenceExternalTransactionId: bet.external, money: { amount: '30.00', currency: 'BRL' } }),
        'Processed',
      );
      expect(result.balance.amount).toBe('120.00');
      expect((await txRow(result.transactionId)).reference_transaction_id).toBe(bet.id);
    });

    it('com referência inexistente → PENDING_REFERENCE', async () => {
      const result = await expectType(command(wallet, { kind: 'WIN', referenceExternalTransactionId: 'nope' }), 'PendingReference');
      expect(result.nextReferenceCheckAt).toEqual(new Date(T0.getTime() + 5_000));
    });

    it('referenciando algo que não é BET → INVALID_REFERENCE_KIND', async () => {
      const win = await processedTx({ kind: 'WIN' });
      const result = await expectType(command(wallet, { kind: 'WIN', referenceExternalTransactionId: win.external }), 'Rejected');
      expect(result.failureCode).toBe(FailureCode.InvalidReferenceKind);
    });
  });

  describe('LOSS', () => {
    it('PROCESSED com o saldo observado, sem lançamento e sem WalletBalanceChanged', async () => {
      const result = await expectType(command(wallet, { kind: 'LOSS', money: { amount: '0.00', currency: 'BRL' } }), 'Processed');

      expect(result.balance.amount).toBe('100.00');
      expect(await countRows(orm, 'wallet_ledger_entries', { transaction_id: result.transactionId })).toBe(0);
      expect((await outbox()).map((e) => e.eventType)).toEqual(['WagerTransactionProcessed']);
      expect(await txRow(result.transactionId)).toMatchObject({ status: 'PROCESSED', observed_balance: '100.00' });
    });
  });

  describe('REFUND', () => {
    it('reverte a BET: credita o mesmo valor', async () => {
      const bet = await processedTx({ money: { amount: '40.00', currency: 'BRL' } });
      const result = await expectType(
        command(wallet, { kind: 'REFUND', referenceExternalTransactionId: bet.external, money: { amount: '40.00', currency: 'BRL' } }),
        'Processed',
      );
      expect(result.balance.amount).toBe('100.00');
      const [entry] = await orm.em.getKnex()('wallet_ledger_entries').where({ transaction_id: result.transactionId });
      expect(entry.direction).toBe('CREDIT');
    });

    it('referenciando WIN → INVALID_REFERENCE_KIND', async () => {
      const win = await processedTx({ kind: 'WIN' });
      const result = await expectType(command(wallet, { kind: 'REFUND', referenceExternalTransactionId: win.external }), 'Rejected');
      expect(result).toMatchObject({ failureCode: 'INVALID_REFERENCE_KIND', balance: { amount: '110.00' } });
    });

    it('referência ausente → PENDING_REFERENCE com evento na outbox', async () => {
      const result = await expectType(command(wallet, { kind: 'REFUND', referenceExternalTransactionId: 'future-bet' }), 'PendingReference');
      expect(await txRow(result.transactionId)).toMatchObject({ status: 'PENDING_REFERENCE', reference_attempts: 1 });
      const [event] = await outbox();
      expect(event).toMatchObject({ eventType: 'WagerTransactionPendingReference', data: { referenceExternalTransactionId: 'future-bet' } });
    });
  });

  describe('ROLLBACK', () => {
    const rollback = (external: string, amount = '10.00') =>
      command(wallet, { kind: 'ROLLBACK', referenceExternalTransactionId: external, money: { amount, currency: 'BRL' } });

    it('de BET → CREDIT', async () => {
      const bet = await processedTx({});
      expect((await expectType(rollback(bet.external), 'Processed')).balance.amount).toBe('100.00');
    });

    it('de WIN → DEBIT', async () => {
      const win = await processedTx({ kind: 'WIN' });
      expect((await expectType(rollback(win.external), 'Processed')).balance.amount).toBe('100.00');
    });

    it('de REFUND → DEBIT', async () => {
      const bet = await processedTx({});
      const refund = await processedTx({ kind: 'REFUND', referenceExternalTransactionId: bet.external });
      expect(refund.result.balance.amount).toBe('100.00');
      expect((await expectType(rollback(refund.external), 'Processed')).balance.amount).toBe('90.00');
    });

    it('de LOSS → INVALID_REFERENCE_KIND', async () => {
      const loss = await processedTx({ kind: 'LOSS' });
      expect((await expectType(rollback(loss.external), 'Rejected')).failureCode).toBe(FailureCode.InvalidReferenceKind);
    });

    it('de WIN já gasto → REVERSAL_WOULD_OVERDRAW, saldo intacto', async () => {
      const win = await processedTx({ kind: 'WIN', money: { amount: '50.00', currency: 'BRL' } });
      await processedTx({ money: { amount: '120.00', currency: 'BRL' } });
      const result = await expectType(rollback(win.external, '50.00'), 'Rejected');
      expect(result).toMatchObject({ failureCode: 'REVERSAL_WOULD_OVERDRAW', balance: { amount: '30.00' } });
      expect(await walletBalance(orm, wallet.walletId)).toBe('30.00');
    });

    it('de referência ainda PENDING_REFERENCE → aguarda (PENDING_REFERENCE)', async () => {
      const pending = command(wallet, { kind: 'WIN', referenceExternalTransactionId: 'missing-bet' });
      await expectType(pending, 'PendingReference');
      await expectType(rollback(pending.payload.externalTransactionId as string), 'PendingReference');
    });
  });

  describe('validação da referência', () => {
    it('REFERENCE_WALLET_MISMATCH: BET de outra wallet', async () => {
      const other = await seedWallet(orm, '50.00');
      const bet = command(other, {});
      await expectType(bet, 'Processed');
      const result = await expectType(
        command(wallet, { kind: 'REFUND', referenceExternalTransactionId: bet.payload.externalTransactionId }),
        'Rejected',
      );
      expect(result.failureCode).toBe(FailureCode.ReferenceWalletMismatch);
      expect((await txRow(result.transactionId)).reference_transaction_id).toBeNull();
      await expectLedgerConsistent(orm, other.walletId);
    });

    it('REFERENCE_PLAYER_MISMATCH: referência na mesma wallet com outro player', async () => {
      const foreign = command({ ...wallet, playerId: 'intruder' }, {});
      expect((await expectType(foreign, 'Rejected')).failureCode).toBe(FailureCode.WalletPlayerMismatch);
      const result = await expectType(
        command(wallet, { kind: 'REFUND', referenceExternalTransactionId: foreign.payload.externalTransactionId }),
        'Rejected',
      );
      expect(result.failureCode).toBe(FailureCode.ReferencePlayerMismatch);
    });

    it('REFERENCE_ROUND_MISMATCH', async () => {
      const bet = await processedTx({ roundId: 'round-A' });
      const result = await expectType(
        command(wallet, { kind: 'REFUND', roundId: 'round-B', referenceExternalTransactionId: bet.external }),
        'Rejected',
      );
      expect(result.failureCode).toBe(FailureCode.ReferenceRoundMismatch);
    });

    it('AMOUNT_MISMATCH', async () => {
      const bet = await processedTx({});
      const result = await expectType(
        command(wallet, { kind: 'REFUND', referenceExternalTransactionId: bet.external, money: { amount: '9.99', currency: 'BRL' } }),
        'Rejected',
      );
      expect(result.failureCode).toBe(FailureCode.AmountMismatch);
    });

    it('REFERENCE_NOT_PROCESSED: referência REJECTED', async () => {
      const bet = command(wallet, { money: { amount: '500.00', currency: 'BRL' } });
      await expectType(bet, 'Rejected');
      const result = await expectType(
        command(wallet, { kind: 'REFUND', referenceExternalTransactionId: bet.payload.externalTransactionId, money: { amount: '500.00', currency: 'BRL' } }),
        'Rejected',
      );
      expect(result.failureCode).toBe(FailureCode.ReferenceNotProcessed);
    });

    it('REFERENCE_ALREADY_REVERSED: segundo REFUND', async () => {
      const bet = await processedTx({});
      await processedTx({ kind: 'REFUND', referenceExternalTransactionId: bet.external });
      const result = await expectType(command(wallet, { kind: 'REFUND', referenceExternalTransactionId: bet.external }), 'Rejected');
      expect(result).toMatchObject({ failureCode: 'REFERENCE_ALREADY_REVERSED', balance: { amount: '100.00' } });
    });

    it('REFERENCE_ALREADY_REVERSED: ROLLBACK de BET que já teve REFUND (uma reversão no total)', async () => {
      const bet = await processedTx({});
      await processedTx({ kind: 'REFUND', referenceExternalTransactionId: bet.external });
      const result = await expectType(command(wallet, { kind: 'ROLLBACK', referenceExternalTransactionId: bet.external }), 'Rejected');
      expect(result.failureCode).toBe(FailureCode.ReferenceAlreadyReversed);
      expect(await walletBalance(orm, wallet.walletId)).toBe('100.00');
    });

    it('referência de outro provider não é encontrada → PENDING_REFERENCE', async () => {
      const bet = await processedTx({});
      await expectType(
        command(wallet, { providerId: 'provider-b', kind: 'REFUND', referenceExternalTransactionId: bet.external }),
        'PendingReference',
      );
    });
  });

  describe('validação da wallet', () => {
    it('WALLET_NOT_FOUND: gravada, sem saldo na resposta', async () => {
      const result = await expectType(command({ walletId: randomUUID(), playerId: wallet.playerId }, {}), 'Rejected');
      expect(result.failureCode).toBe(FailureCode.WalletNotFound);
      expect(result.balance).toBeUndefined();
      expect(await txRow(result.transactionId)).toMatchObject({ status: 'REJECTED' });
    });

    it('WALLET_PLAYER_MISMATCH não expõe o saldo da wallet', async () => {
      const result = await expectType(command({ ...wallet, playerId: 'other-player' }, {}), 'Rejected');
      expect(result).toMatchObject({ failureCode: 'WALLET_PLAYER_MISMATCH' });
      expect(result.balance).toBeUndefined();
    });

    it('CURRENCY_MISMATCH', async () => {
      const result = await expectType(command(wallet, { money: { amount: '10.00', currency: 'USD' } }), 'Rejected');
      expect(result.failureCode).toBe(FailureCode.CurrencyMismatch);
    });
  });

  describe('entrada inválida → InvalidInput, nada gravado', () => {
    it.each(['BET', 'WIN', 'REFUND', 'ROLLBACK'])('%s com valor 0.00', async (kind) => {
      const result = await run(
        command(wallet, { kind, referenceExternalTransactionId: kind === 'BET' ? undefined : 'ref', money: { amount: '0.00', currency: 'BRL' } }),
      );
      expect(result.type).toBe('InvalidInput');
      expect(await countRows(orm, 'wager_transactions')).toBe(1); // só a OPENING do seed
      expect(await countRows(orm, 'outbox_messages')).toBe(0);
    });

    it.each([
      ['amount number', { money: { amount: 10, currency: 'BRL' } }],
      ['amount com 3 casas', { money: { amount: '1.001', currency: 'BRL' } }],
      ['money ausente', { money: undefined }],
      ['kind OPENING', { kind: 'OPENING' }],
      ['kind desconhecido', { kind: 'JACKPOT' }],
      ['walletId não-UUID', { walletId: 'abc' }],
      ['REFUND sem referência', { kind: 'REFUND' }],
      ['BET com referência', { referenceExternalTransactionId: 'x' }],
      ['playerId vazio', { playerId: ' ' }],
    ])('%s', async (_, payload) => {
      expect((await run(command(wallet, payload))).type).toBe('InvalidInput');
      expect(await countRows(orm, 'wager_transactions')).toBe(1);
    });
  });

  describe('idempotência', () => {
    it('replay devolve o resultado original com o saldo da época, mesmo depois de outras transações', async () => {
      const first = command(wallet, { money: { amount: '25.00', currency: 'BRL' } });
      const original = await expectType(first, 'Processed');
      await processedTx({ money: { amount: '10.00', currency: 'BRL' } });

      const replay = await run(first);
      expect(replay).toEqual({ ...original, idempotentReplay: true });
      expect(await walletBalance(orm, wallet.walletId)).toBe('65.00');
      expect(await countRows(orm, 'wager_transactions', { idempotency_key: first.idempotencyKey })).toBe(1);
      expect(await countRows(orm, 'outbox_messages', { aggregate_id: original.transactionId })).toBe(1);
    });

    it('"25" e "25.00" são o mesmo payload (replay)', async () => {
      const first = command(wallet, { money: { amount: '25.00', currency: 'BRL' } });
      await expectType(first, 'Processed');
      const again = { ...first, payload: { ...first.payload, money: { amount: '25', currency: 'BRL' } } };
      expect((await run(again)) as { idempotentReplay: boolean }).toMatchObject({ idempotentReplay: true });
    });

    it('replay de rejeição devolve o mesmo failureCode e saldo', async () => {
      const bet = command(wallet, { money: { amount: '500.00', currency: 'BRL' } });
      const original = await expectType(bet, 'Rejected');
      await processedTx({ kind: 'WIN', money: { amount: '1000.00', currency: 'BRL' } });
      expect(await run(bet)).toEqual({ ...original, idempotentReplay: true });
    });

    it('replay de PENDING_REFERENCE', async () => {
      const refund = command(wallet, { kind: 'REFUND', referenceExternalTransactionId: 'later' });
      const original = await expectType(refund, 'PendingReference');
      expect(await run(refund)).toEqual({ ...original, idempotentReplay: true });
    });

    it('mesma key com payload diferente → conflito, nada gravado', async () => {
      const first = command(wallet, { money: { amount: '25.00', currency: 'BRL' } });
      const original = await expectType(first, 'Processed');
      const different = { ...first, payload: { ...first.payload, money: { amount: '26.00', currency: 'BRL' } } };

      expect(await run(different)).toEqual({ type: 'IdempotencyConflict', existingTransactionId: original.transactionId });
      expect(await countRows(orm, 'wager_transactions')).toBe(2);
      expect(await countRows(orm, 'outbox_messages')).toBe(2);
      expect(await walletBalance(orm, wallet.walletId)).toBe('75.00');
    });

    it('mesmo (providerId, externalTransactionId) com outra key → conflito', async () => {
      const first = command(wallet, {});
      await expectType(first, 'Processed');
      await expectType({ ...first, idempotencyKey: 'another-key' }, 'IdempotencyConflict');
    });

    it('header e metadados não entram no hash: outro correlationId é replay', async () => {
      const first = command(wallet, {});
      await expectType(first, 'Processed');
      expect(await run({ ...first, correlationId: 'corr-2' })).toMatchObject({ idempotentReplay: true });
    });
  });

  describe('inbox (contexto da Fase 5)', () => {
    const inbox = (messageId: string) => ({ consumerName: 'wager-consumer', messageId, payloadHash: 'h' });

    it('grava a inbox processada na mesma transação, e a causation dos eventos é a mensagem', async () => {
      const cmd = command(wallet, {}, { inbox: inbox('msg-1') });
      await expectType(cmd, 'Processed');
      const [row] = await orm.em.getKnex()('inbox_messages').where({ message_id: 'msg-1' });
      expect(new Date(row.processed_at)).toEqual(T0);
      const events = await outbox();
      expect(events.find((e) => e.eventType === 'WagerTransactionProcessed')?.causationId).toBe('msg-1');
    });

    it('a mesma mensagem redeliverada → replay (23505 na inbox é relido)', async () => {
      const cmd = command(wallet, {}, { inbox: inbox('msg-1') });
      await expectType(cmd, 'Processed');
      expect(await run(cmd)).toMatchObject({ type: 'Processed', idempotentReplay: true });
      expect(await countRows(orm, 'inbox_messages')).toBe(1);
    });

    it('outra mensagem com a mesma transação → replay, e a nova mensagem fica registrada', async () => {
      const cmd = command(wallet, {}, { inbox: inbox('msg-1') });
      await expectType(cmd, 'Processed');
      expect(await run({ ...cmd, inbox: inbox('msg-2') })).toMatchObject({ idempotentReplay: true });
      expect(await countRows(orm, 'inbox_messages')).toBe(2);
    });
  });

  describe('concorrência (barreiras)', () => {
    it('lock da wallet ocupado além do lock_timeout → TransientFailure, conflito contado e logado', async () => {
      const { useCase: impatient, telemetry, logs } = buildUseCase(orm, { lockTimeoutMs: 200 });
      const knex = orm.em.getKnex();
      const trx = await knex.transaction();
      try {
        await trx.raw('select id from wallets where id = ? for update', [wallet.walletId]);
        expect(await impatient.execute(command(wallet, {}))).toEqual({ type: 'TransientFailure', reason: 'lock_timeout' });
      } finally {
        await trx.rollback();
      }
      expect(telemetry.count('lock_timeout')).toBe(1);
      expect(JSON.parse(logs[0] ?? '{}')).toMatchObject({ event: 'wallet_lock_conflict', reason: 'lock_timeout', walletId: wallet.walletId });
      expect(await countRows(orm, 'wager_transactions')).toBe(1);
    });

    it('UPDATE com version divergente → WalletVersionConflictError e rollback', async () => {
      const unitOfWork = new MikroOrmWagerUnitOfWork(orm.em);
      const action = unitOfWork.run(async (repository) => {
        const locked = (await repository.lockWallet(wallet.walletId)) as Wallet;
        const stale = Wallet.rehydrate({
          id: locked.id,
          playerId: locked.playerId,
          currency: locked.currency,
          balance: Money.from({ amount: '1.00', currency: 'BRL' }),
          version: locked.version + 1,
          createdAt: locked.createdAt,
          updatedAt: locked.updatedAt,
        });
        await repository.updateWallet(stale, locked.version + 1);
      });
      await expect(action).rejects.toBeInstanceOf(WalletVersionConflictError);
      expect(await walletBalance(orm, wallet.walletId)).toBe('100.00');
    });
  });
});
