import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import type { MikroORM } from '@mikro-orm/postgresql';
import { randomUUID } from 'node:crypto';
import type { ProcessWagerTransactionResult } from '../../../src/application/wagering/process-wager-transaction';
import { PENDING_REFERENCE_TTL_MS } from '../../../src/application/wagering/wager-settlement';
import { FailureCode } from '../../../src/domain/failure-code';
import { command, walletBalance, type WalletRef } from '../application/harness';
import { T0, expectLedgerConsistent, openOrm, processed, seedWallet, truncateAll } from '../persistence/db';
import { PendingReferenceWorker } from '../../../src/interfaces/workers/pending-reference-worker';
import { ManualClock, deferred } from './outbox-harness';
import {
  buildPendingFixture,
  counterTotal,
  entriesOf,
  eventsOf,
  pendingCount,
  txByExternal,
  waitForLockWaiter,
  TEST_WORKER_OPTIONS,
} from './pending-harness';

const brl = (amount: string) => ({ amount, currency: 'BRL' });

/**
 * Worker de referências pendentes (Fase 7) com Postgres real e relógio manual: o teste avança o
 * tempo e chama `runOnce()` direto (sem sleep). O loop/flag/shutdown têm testes próprios no fim.
 */
describe('worker de referências pendentes (Postgres real)', () => {
  let orm: MikroORM;
  let clock: ManualClock;
  let fx: ReturnType<typeof buildPendingFixture>;

  beforeAll(async () => {
    orm = await openOrm();
  });

  afterAll(async () => {
    await orm.close(true);
  });

  beforeEach(async () => {
    await truncateAll(orm);
    clock = new ManualClock(T0);
    fx = buildPendingFixture(orm, clock);
  });

  const submit = (wallet: WalletRef, payload: Record<string, unknown>, correlationId = 'corr-1') =>
    fx.useCase.execute(command(wallet, payload, { correlationId }));

  async function expectProcessed(result: ProcessWagerTransactionResult, balance: string): Promise<void> {
    expect(result).toMatchObject({ type: 'Processed', balance: brl(balance) });
  }

  it('ROLLBACK antes da BET → PENDING_REFERENCE → BET chega → worker resolve; um lançamento por transação; replay devolve o final', async () => {
    const wallet = await seedWallet(orm, '100.00');
    const rollback = { externalTransactionId: 'rb-1', kind: 'ROLLBACK', referenceExternalTransactionId: 'bet-1', money: brl('30.00') };

    const pending = await submit(wallet, rollback, 'corr-rollback');
    expect(pending).toMatchObject({ type: 'PendingReference', nextReferenceCheckAt: new Date(T0.getTime() + 5_000) });
    await expectProcessed(await submit(wallet, { externalTransactionId: 'bet-1', money: brl('30.00') }, 'corr-bet'), '70.00');

    expect(await fx.worker.runOnce()).toEqual({ candidates: 1, progressed: 1 });

    const rb = await txByExternal(orm, 'rb-1');
    const bet = await txByExternal(orm, 'bet-1');
    expect(rb).toMatchObject({ status: 'PROCESSED', observed_balance: '100.00', reference_transaction_id: bet.id, next_reference_check_at: null });
    expect(await walletBalance(orm, wallet.walletId)).toBe('100.00');
    expect(await entriesOf(orm, rb.id)).toBe(1);
    expect(await entriesOf(orm, bet.id)).toBe(1);

    // Eventos: correlação da requisição original; causa = o evento de pendência.
    const events = await eventsOf(orm, rb.id);
    expect(events.map((e) => e.event_type)).toEqual(['WagerTransactionPendingReference', 'WagerTransactionProcessed']);
    const [pendingEvent, processedEvent] = events;
    // WalletBalanceChanged tem a wallet como agregado.
    const balanceEvent = (await eventsOf(orm, wallet.walletId)).find((e) => e.payload.data.transactionId === rb.id);
    expect(processedEvent?.payload).toMatchObject({ correlationId: 'corr-rollback', causationId: pendingEvent?.id });
    expect(balanceEvent?.payload).toMatchObject({ correlationId: 'corr-rollback', causationId: processedEvent?.id });

    // Replay depois de outra movimentação: devolve o saldo observado na resolução.
    await expectProcessed(await submit(wallet, { externalTransactionId: 'bet-2', money: brl('5.00') }), '95.00');
    expect(await submit(wallet, rollback, 'corr-rollback')).toEqual({
      type: 'Processed',
      transactionId: rb.id,
      status: 'PROCESSED' as never,
      balance: brl('100.00'),
      idempotentReplay: true,
    });
    expect(await counterTotal(fx.metrics.pendingReferenceResolved, { status: 'PROCESSED' })).toBe(1);
    await expectLedgerConsistent(orm, wallet.walletId);
  });

  it('REFUND antes da BET → resolve com crédito; saldo de volta ao inicial', async () => {
    const wallet = await seedWallet(orm, '100.00');
    expect((await submit(wallet, { externalTransactionId: 'rf-1', kind: 'REFUND', referenceExternalTransactionId: 'bet-1', money: brl('40.00') })).type).toBe('PendingReference');
    await expectProcessed(await submit(wallet, { externalTransactionId: 'bet-1', money: brl('40.00') }), '60.00');

    expect((await fx.worker.runOnce()).progressed).toBe(1);

    const refund = await txByExternal(orm, 'rf-1');
    expect(refund).toMatchObject({ status: 'PROCESSED', observed_balance: '100.00' });
    expect(await entriesOf(orm, refund.id)).toBe(1);
    expect(await walletBalance(orm, wallet.walletId)).toBe('100.00');
    await expectLedgerConsistent(orm, wallet.walletId);
  });

  it.each([
    ['valor diferente', { money: brl('31.00') }, FailureCode.AmountMismatch],
    ['rodada diferente', { roundId: 'round-2' }, FailureCode.ReferenceRoundMismatch],
    ['referência REJECTED (saldo insuficiente)', { money: brl('500.00') }, FailureCode.ReferenceNotProcessed],
    ['kind não reversível (LOSS)', { kind: 'LOSS', money: brl('0.00') }, FailureCode.InvalidReferenceKind],
  ] as const)('referência chega mas não bate (%s) → REJECTED com o código certo, sem lançamento', async (_name, betOverride, code) => {
    const wallet = await seedWallet(orm, '100.00');
    await submit(wallet, { externalTransactionId: 'rb-1', kind: 'ROLLBACK', referenceExternalTransactionId: 'bet-1', money: brl('30.00') });
    await submit(wallet, { externalTransactionId: 'bet-1', money: brl('30.00'), ...betOverride });

    expect((await fx.worker.runOnce()).progressed).toBe(1);

    const rb = await txByExternal(orm, 'rb-1');
    expect(rb).toMatchObject({ status: 'REJECTED', failure_code: code, next_reference_check_at: null });
    expect(await entriesOf(orm, rb.id)).toBe(0);
    expect((await eventsOf(orm, rb.id)).map((e) => e.event_type)).toEqual(['WagerTransactionPendingReference', 'WagerTransactionRejected']);
    expect(await counterTotal(fx.metrics.pendingReferenceResolved, { status: 'REJECTED' })).toBe(1);
    await expectLedgerConsistent(orm, wallet.walletId);
  });

  it('referência de outro player na mesma wallet → REFERENCE_PLAYER_MISMATCH', async () => {
    const wallet = await seedWallet(orm, '100.00');
    await submit(wallet, { externalTransactionId: 'rb-1', kind: 'ROLLBACK', referenceExternalTransactionId: 'bet-1', money: brl('30.00') });
    // A BET de outro player é rejeitada (WALLET_PLAYER_MISMATCH) sem travar a wallet, então não antecipa
    // nada (o UPDATE só toca pendentes da wallet travada): o worker vê na hora agendada.
    clock.advance(1_000);
    await submit({ ...wallet, playerId: 'intruso' }, { externalTransactionId: 'bet-1', money: brl('30.00') });
    expect((await txByExternal(orm, 'rb-1')).next_reference_check_at).toEqual(new Date(T0.getTime() + 5_000));
    expect(await fx.worker.runOnce()).toEqual({ candidates: 0, progressed: 0 });
    clock.advance(4_000);

    expect((await fx.worker.runOnce()).progressed).toBe(1);
    expect(await txByExternal(orm, 'rb-1')).toMatchObject({ status: 'REJECTED', failure_code: FailureCode.ReferencePlayerMismatch });
    expect(await walletBalance(orm, wallet.walletId)).toBe('100.00');
    await expectLedgerConsistent(orm, wallet.walletId);
  });

  it('reversão que deixaria saldo negativo no momento da resolução → REVERSAL_WOULD_OVERDRAW', async () => {
    const wallet = await seedWallet(orm, '100.00');
    await submit(wallet, { externalTransactionId: 'rb-1', kind: 'ROLLBACK', referenceExternalTransactionId: 'win-1', money: brl('50.00') });
    await expectProcessed(await submit(wallet, { externalTransactionId: 'win-1', kind: 'WIN', money: brl('50.00') }), '150.00');
    await expectProcessed(await submit(wallet, { externalTransactionId: 'bet-1', money: brl('140.00') }), '10.00');

    expect((await fx.worker.runOnce()).progressed).toBe(1);

    const rb = await txByExternal(orm, 'rb-1');
    expect(rb).toMatchObject({ status: 'REJECTED', failure_code: FailureCode.ReversalWouldOverdraw, observed_balance: '10.00' });
    expect(await entriesOf(orm, rb.id)).toBe(0);
    expect(await walletBalance(orm, wallet.walletId)).toBe('10.00');
    await expectLedgerConsistent(orm, wallet.walletId);
  });

  it('referência já estornada no momento da resolução → REFERENCE_ALREADY_REVERSED', async () => {
    const wallet = await seedWallet(orm, '100.00');
    await submit(wallet, { externalTransactionId: 'rb-1', kind: 'ROLLBACK', referenceExternalTransactionId: 'bet-1', money: brl('30.00') });
    await submit(wallet, { externalTransactionId: 'bet-1', money: brl('30.00') });
    // O REFUND chega com a BET já processada e é aplicado na entrada, antes do worker.
    await expectProcessed(
      await submit(wallet, { externalTransactionId: 'rf-1', kind: 'REFUND', referenceExternalTransactionId: 'bet-1', money: brl('30.00') }),
      '100.00',
    );

    expect((await fx.worker.runOnce()).progressed).toBe(1);
    expect(await txByExternal(orm, 'rb-1')).toMatchObject({ status: 'REJECTED', failure_code: FailureCode.ReferenceAlreadyReversed });
    expect(await walletBalance(orm, wallet.walletId)).toBe('100.00');
    await expectLedgerConsistent(orm, wallet.walletId);
  });

  it('encadeado: ROLLBACK de um REFUND que espera a BET → tudo resolve na ordem certa', async () => {
    const wallet = await seedWallet(orm, '100.00');
    await submit(wallet, { externalTransactionId: 'rb-1', kind: 'ROLLBACK', referenceExternalTransactionId: 'rf-1', money: brl('30.00') });
    await submit(wallet, { externalTransactionId: 'rf-1', kind: 'REFUND', referenceExternalTransactionId: 'bet-1', money: brl('30.00') });
    await expectProcessed(await submit(wallet, { externalTransactionId: 'bet-1', money: brl('30.00') }), '70.00');

    // 1º ciclo: só o REFUND foi antecipado pela BET; ao resolver, ele antecipa o ROLLBACK.
    expect(await fx.worker.runOnce()).toEqual({ candidates: 1, progressed: 1 });
    expect(await txByExternal(orm, 'rf-1')).toMatchObject({ status: 'PROCESSED', observed_balance: '100.00' });
    expect(await txByExternal(orm, 'rb-1')).toMatchObject({ status: 'PENDING_REFERENCE', next_reference_check_at: T0 });

    // 2º ciclo: o ROLLBACK estorna o REFUND (débito).
    expect(await fx.worker.runOnce()).toEqual({ candidates: 1, progressed: 1 });
    const rb = await txByExternal(orm, 'rb-1');
    expect(rb).toMatchObject({ status: 'PROCESSED', observed_balance: '70.00', reference_transaction_id: (await txByExternal(orm, 'rf-1')).id });
    expect(await walletBalance(orm, wallet.walletId)).toBe('70.00');
    for (const ext of ['bet-1', 'rf-1', 'rb-1']) expect(await entriesOf(orm, (await txByExternal(orm, ext)).id)).toBe(1);
    expect(await fx.worker.runOnce()).toEqual({ candidates: 0, progressed: 0 });
    await expectLedgerConsistent(orm, wallet.walletId);
  });

  it('backoff 5s, 10s, … com a última checagem no prazo; expirado → REJECTED REFERENCE_NOT_FOUND + evento na mesma transação', async () => {
    const wallet = await seedWallet(orm, '100.00');
    await submit(wallet, { externalTransactionId: 'rb-1', kind: 'ROLLBACK', referenceExternalTransactionId: 'bet-1', money: brl('30.00') }, 'corr-rb');

    // Ainda não vencida: nada a fazer.
    expect(await fx.worker.runOnce()).toEqual({ candidates: 0, progressed: 0 });

    clock.advance(5_000);
    expect((await fx.worker.runOnce()).progressed).toBe(1);
    expect(await txByExternal(orm, 'rb-1')).toMatchObject({
      status: 'PENDING_REFERENCE',
      reference_attempts: 2,
      next_reference_check_at: new Date(T0.getTime() + 5_000 + 10_000),
    });

    // Perto do prazo: o backoff (10min de teto) é limitado ao deadline (createdAt + 1h).
    const deadline = new Date(T0.getTime() + PENDING_REFERENCE_TTL_MS);
    clock.advance(PENDING_REFERENCE_TTL_MS - 5_000 - 10_000);
    expect((await fx.worker.runOnce()).progressed).toBe(1);
    expect(await txByExternal(orm, 'rb-1')).toMatchObject({ status: 'PENDING_REFERENCE', reference_attempts: 3, next_reference_check_at: deadline });

    clock.advance(10_000);
    expect((await fx.worker.runOnce()).progressed).toBe(1);
    const rb = await txByExternal(orm, 'rb-1');
    expect(rb).toMatchObject({ status: 'REJECTED', failure_code: FailureCode.ReferenceNotFound, observed_balance: '100.00', next_reference_check_at: null });
    const events = await eventsOf(orm, rb.id);
    expect(events.map((e) => e.event_type)).toEqual(['WagerTransactionPendingReference', 'WagerTransactionRejected']);
    expect(events[1]?.payload).toMatchObject({ correlationId: 'corr-rb', causationId: events[0]?.id });
    expect(await counterTotal(fx.metrics.pendingReferenceExpired)).toBe(1);
    expect(await counterTotal(fx.metrics.pendingReferenceRescheduled)).toBe(2);

    // A BET chegando depois não ressuscita a rejeição; o replay devolve o final.
    await expectProcessed(await submit(wallet, { externalTransactionId: 'bet-1', money: brl('30.00') }), '70.00');
    expect(await fx.worker.runOnce()).toEqual({ candidates: 0, progressed: 0 });
    expect(
      await submit(wallet, { externalTransactionId: 'rb-1', kind: 'ROLLBACK', referenceExternalTransactionId: 'bet-1', money: brl('30.00') }, 'corr-rb'),
    ).toMatchObject({ type: 'Rejected', failureCode: FailureCode.ReferenceNotFound, balance: brl('100.00'), idempotentReplay: true });
    await expectLedgerConsistent(orm, wallet.walletId);
  });

  it('referência existente mas ainda pendente → reagenda; esgotado o prazo → REFERENCE_NOT_FOUND', async () => {
    fx = buildPendingFixture(orm, clock, { ttlMs: 30_000 });
    const wallet = await seedWallet(orm, '100.00');
    await submit(wallet, { externalTransactionId: 'rb-1', kind: 'ROLLBACK', referenceExternalTransactionId: 'rf-1', money: brl('30.00') });
    await submit(wallet, { externalTransactionId: 'rf-1', kind: 'REFUND', referenceExternalTransactionId: 'bet-1', money: brl('30.00') });

    clock.advance(5_000);
    expect(await fx.worker.runOnce()).toEqual({ candidates: 2, progressed: 2 });
    expect(await txByExternal(orm, 'rb-1')).toMatchObject({ status: 'PENDING_REFERENCE', reference_attempts: 2 });

    clock.advance(30_000);
    await fx.worker.runOnce();
    for (const ext of ['rb-1', 'rf-1']) {
      expect(await txByExternal(orm, ext)).toMatchObject({ status: 'REJECTED', failure_code: FailureCode.ReferenceNotFound });
    }
    expect(await pendingCount(orm)).toBe(0);
    await expectLedgerConsistent(orm, wallet.walletId);
  });

  it('caminho rápido: a BET antecipa só as pendentes da mesma wallet que a referenciam (o trigger permite o UPDATE)', async () => {
    const wallet = await seedWallet(orm, '100.00');
    const other = await seedWallet(orm, '100.00');
    await submit(wallet, { externalTransactionId: 'rb-1', kind: 'ROLLBACK', referenceExternalTransactionId: 'bet-1', money: brl('30.00') });
    await submit(wallet, { externalTransactionId: 'rb-x', kind: 'ROLLBACK', referenceExternalTransactionId: 'bet-x', money: brl('30.00') });
    await submit(other, { externalTransactionId: 'rb-other', kind: 'ROLLBACK', referenceExternalTransactionId: 'bet-1', money: brl('30.00') });
    const scheduled = new Date(T0.getTime() + 5_000);

    clock.advance(1_000);
    await submit(wallet, { externalTransactionId: 'bet-1', money: brl('30.00') });

    expect((await txByExternal(orm, 'rb-1')).next_reference_check_at).toEqual(clock.now());
    expect((await txByExternal(orm, 'rb-x')).next_reference_check_at).toEqual(scheduled);
    expect((await txByExternal(orm, 'rb-other')).next_reference_check_at).toEqual(scheduled);
    // Antecipar não conta tentativa nem muda o estado: quem resolve é o worker.
    expect(await txByExternal(orm, 'rb-1')).toMatchObject({ status: 'PENDING_REFERENCE', reference_attempts: 1 });
    expect(await fx.worker.runOnce()).toEqual({ candidates: 1, progressed: 1 });
    expect(await txByExternal(orm, 'rb-1')).toMatchObject({ status: 'PROCESSED', observed_balance: '100.00' });
    expect(await walletBalance(orm, wallet.walletId)).toBe('100.00');
    await expectLedgerConsistent(orm, wallet.walletId);
    await expectLedgerConsistent(orm, other.walletId);
  });

  it('caminho rápido: outro provider com o mesmo id externo não antecipa; pendente já agendada antes não é atrasada', async () => {
    const wallet = await seedWallet(orm, '100.00');
    await submit(wallet, { providerId: 'provider-a', externalTransactionId: 'rb-a', kind: 'ROLLBACK', referenceExternalTransactionId: 'bet-1', money: brl('30.00') });
    clock.advance(1_000);
    await submit(wallet, { providerId: 'provider-b', externalTransactionId: 'bet-1', money: brl('30.00') });
    expect((await txByExternal(orm, 'rb-a')).next_reference_check_at).toEqual(new Date(T0.getTime() + 5_000));

    // Vencida (agendada antes de "agora"): o UPDATE só mexe em quem está no futuro.
    clock.advance(10_000);
    await submit(wallet, { providerId: 'provider-a', externalTransactionId: 'bet-2', money: brl('1.00') });
    await submit(wallet, { providerId: 'provider-a', externalTransactionId: 'rb-late', kind: 'ROLLBACK', referenceExternalTransactionId: 'bet-1', money: brl('30.00') });
    clock.advance(1_000);
    await submit(wallet, { providerId: 'provider-a', externalTransactionId: 'bet-1', money: brl('30.00') });
    expect((await txByExternal(orm, 'rb-a')).next_reference_check_at).toEqual(new Date(T0.getTime() + 5_000));
    expect((await txByExternal(orm, 'rb-late')).next_reference_check_at).toEqual(clock.now());
    await expectLedgerConsistent(orm, wallet.walletId);
  });

  it('sem correlation_id gravado nem evento de pendência → correlationId e causationId = id da transação', async () => {
    const wallet = await seedWallet(orm, '100.00');
    const bet = processed({ wallet_id: wallet.walletId, player_id: wallet.playerId, external_transaction_id: 'bet-legacy', amount: '30.00', observed_balance: '100.00' });
    const legacy = {
      id: randomUUID(),
      provider_id: 'provider-a',
      external_transaction_id: 'rf-legacy',
      idempotency_key: 'provider-a:rf-legacy',
      payload_hash: 'hash',
      wallet_id: wallet.walletId,
      player_id: wallet.playerId,
      round_id: 'round-1',
      game_id: 'game-1',
      kind: 'LOSS',
      amount: '0.00',
      currency: 'BRL',
      reference_external_transaction_id: 'bet-legacy',
      status: 'PENDING_REFERENCE',
      reference_attempts: 1,
      next_reference_check_at: T0,
      created_at: T0,
    };
    await orm.em.getKnex()('wager_transactions').insert([bet, legacy]);

    expect((await fx.worker.runOnce()).progressed).toBe(1);
    const [processedEvent] = await eventsOf(orm, legacy.id);
    expect(processedEvent?.event_type).toBe('WagerTransactionProcessed');
    expect(processedEvent?.payload).toMatchObject({ correlationId: legacy.id, causationId: legacy.id });
    expect(await txByExternal(orm, 'rf-legacy')).toMatchObject({ status: 'PROCESSED', observed_balance: '100.00' });
    await expectLedgerConsistent(orm, wallet.walletId);
  });

  it('correlation_id é imutável no banco (trigger)', async () => {
    const wallet = await seedWallet(orm, '100.00');
    await submit(wallet, { externalTransactionId: 'rb-1', kind: 'ROLLBACK', referenceExternalTransactionId: 'bet-1', money: brl('30.00') }, 'corr-a');
    expect((await txByExternal(orm, 'rb-1')).correlation_id).toBe('corr-a');
    const error = await orm.em
      .getKnex()('wager_transactions')
      .where({ external_transaction_id: 'rb-1' })
      .update({ correlation_id: 'corr-b' })
      .then(() => undefined, (e: { code?: string }) => e);
    expect(error?.code).toBe('23001');
  });

  it('wallet ocupada → candidata pulada (wallet_busy) sem esperar o lock; liberada, resolve', async () => {
    fx = buildPendingFixture(orm, clock, { lockTimeoutMs: 10_000 });
    const wallet = await seedWallet(orm, '100.00');
    await submit(wallet, { externalTransactionId: 'rb-1', kind: 'ROLLBACK', referenceExternalTransactionId: 'bet-1', money: brl('30.00') });
    await submit(wallet, { externalTransactionId: 'bet-1', money: brl('30.00') });

    const locked = deferred();
    const release = deferred();
    const holder = orm.em.fork().transactional(async (em) => {
      await em.execute('select id from wallets where id = ? for update', [wallet.walletId]);
      locked.resolve();
      await release.promise;
    });
    await locked.promise;
    const started = Date.now();
    expect(await fx.worker.runOnce()).toEqual({ candidates: 1, progressed: 0 });
    // Com lock_timeout de 10s na fixture, só SKIP LOCKED explica voltar tão rápido.
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(await counterTotal(fx.metrics.pendingReferenceSkipped, { reason: 'wallet_busy' })).toBe(1);
    release.resolve();
    await holder;

    expect(await fx.worker.runOnce()).toEqual({ candidates: 1, progressed: 1 });
    expect(await walletBalance(orm, wallet.walletId)).toBe('100.00');
    await expectLedgerConsistent(orm, wallet.walletId);
  });

  it('candidata já resolvida por outro entre a busca e o lock → pulada (not_due), sem efeito', async () => {
    const wallet = await seedWallet(orm, '100.00');
    await submit(wallet, { externalTransactionId: 'rb-1', kind: 'ROLLBACK', referenceExternalTransactionId: 'bet-1', money: brl('30.00') });
    await submit(wallet, { externalTransactionId: 'bet-1', money: brl('30.00') });
    const [candidate] = await fx.resolver.findDue(10);

    expect(await fx.resolver.resolve(candidate!)).toMatchObject({ type: 'resolved' });
    expect(await fx.resolver.resolve(candidate!)).toMatchObject({ type: 'skipped', reason: 'not_due' });
    expect(await entriesOf(orm, (await txByExternal(orm, 'rb-1')).id)).toBe(1);
    await expectLedgerConsistent(orm, wallet.walletId);
  });

  it('transação pendente travada por outra sessão → transient/lock_timeout (sem efeito, volta depois)', async () => {
    fx = buildPendingFixture(orm, clock, { lockTimeoutMs: 200 });
    const wallet = await seedWallet(orm, '100.00');
    await submit(wallet, { externalTransactionId: 'rb-1', kind: 'ROLLBACK', referenceExternalTransactionId: 'bet-1', money: brl('30.00') });
    await submit(wallet, { externalTransactionId: 'bet-1', money: brl('30.00') });
    const rb = await txByExternal(orm, 'rb-1');

    const locked = deferred();
    const release = deferred();
    const holder = orm.em.fork().transactional(async (em) => {
      await em.execute('select id from wager_transactions where id = ? for update', [rb.id]);
      locked.resolve();
      await release.promise;
    });
    await locked.promise;
    const [candidate] = await fx.resolver.findDue(10);
    expect(await fx.resolver.resolve(candidate!)).toEqual({ type: 'transient', transactionId: rb.id, reason: 'lock_timeout' });
    release.resolve();
    await holder;

    expect(await txByExternal(orm, 'rb-1')).toMatchObject({ status: 'PENDING_REFERENCE', reference_attempts: 1 });
    expect(await fx.resolver.resolve(candidate!)).toMatchObject({ type: 'resolved' });
    await expectLedgerConsistent(orm, wallet.walletId);
  });

  it('waitForWallet: espera o lock da wallet (em vez de pular) e resolve quando ele é liberado', async () => {
    const wallet = await seedWallet(orm, '100.00');
    await submit(wallet, { externalTransactionId: 'rb-1', kind: 'ROLLBACK', referenceExternalTransactionId: 'bet-1', money: brl('30.00') });
    await submit(wallet, { externalTransactionId: 'bet-1', money: brl('30.00') });
    const [candidate] = await fx.resolver.findDue(10);

    const locked = deferred();
    const release = deferred();
    const holder = orm.em.fork().transactional(async (em) => {
      await em.execute('select id from wallets where id = ? for update', [wallet.walletId]);
      locked.resolve();
      await release.promise;
    });
    await locked.promise;
    const resolving = fx.resolver.resolve(candidate!, { waitForWallet: true });
    await waitForLockWaiter(orm); // a sessão do resolver está na fila do lock
    release.resolve();
    await holder;
    expect(await resolving).toMatchObject({ type: 'resolved', status: 'PROCESSED' });
    await expectLedgerConsistent(orm, wallet.walletId);
  });

  it('fail(): PENDING_REFERENCE → FAILED INFRASTRUCTURE_FAILURE com WagerTransactionRejected; já terminal → not_due', async () => {
    const wallet = await seedWallet(orm, '100.00');
    await submit(wallet, { externalTransactionId: 'rf-1', kind: 'REFUND', referenceExternalTransactionId: 'bet-1', money: brl('30.00') }, 'corr-fail');
    await submit(wallet, { externalTransactionId: 'rb-2', kind: 'ROLLBACK', referenceExternalTransactionId: 'rf-1', money: brl('30.00') });
    const rf = await txByExternal(orm, 'rf-1');
    const candidate = { id: rf.id, walletId: wallet.walletId, playerId: wallet.playerId };

    expect(await fx.resolver.fail(candidate)).toEqual({ type: 'failed', transactionId: rf.id });
    expect(await txByExternal(orm, 'rf-1')).toMatchObject({ status: 'FAILED', failure_code: FailureCode.InfrastructureFailure, next_reference_check_at: null });
    const events = await eventsOf(orm, rf.id);
    expect(events.map((e) => e.event_type)).toEqual(['WagerTransactionPendingReference', 'WagerTransactionRejected']);
    expect(events[1]?.payload).toMatchObject({ correlationId: 'corr-fail', causationId: events[0]?.id, data: { failureCode: 'INFRASTRUCTURE_FAILURE' } });
    // Terminal: antecipa quem a referencia (rb-2 vai ver REFERENCE_NOT_PROCESSED).
    expect((await txByExternal(orm, 'rb-2')).next_reference_check_at).toEqual(T0);

    expect(await fx.resolver.fail(candidate)).toEqual({ type: 'skipped', transactionId: rf.id, reason: 'not_due' });
    expect((await fx.worker.runOnce()).progressed).toBe(1);
    expect(await txByExternal(orm, 'rb-2')).toMatchObject({ status: 'REJECTED', failure_code: FailureCode.ReferenceNotProcessed });
    // Replay da original devolve o FAILED.
    expect(
      await submit(wallet, { externalTransactionId: 'rf-1', kind: 'REFUND', referenceExternalTransactionId: 'bet-1', money: brl('30.00') }, 'corr-fail'),
    ).toMatchObject({ type: 'Rejected', status: 'FAILED', failureCode: FailureCode.InfrastructureFailure, idempotentReplay: true });
    await expectLedgerConsistent(orm, wallet.walletId);
  });

  describe('loop', () => {
    it('start() resolve sem chamada manual, mede o gauge por intervalo e stop() para o loop', async () => {
      const wallet = await seedWallet(orm, '100.00');
      await submit(wallet, { externalTransactionId: 'rb-1', kind: 'ROLLBACK', referenceExternalTransactionId: 'bet-1', money: brl('30.00') });
      await submit(wallet, { externalTransactionId: 'rb-2', kind: 'ROLLBACK', referenceExternalTransactionId: 'bet-2', money: brl('30.00') });
      await submit(wallet, { externalTransactionId: 'bet-1', money: brl('30.00') });

      fx.worker.start();
      try {
        await waitFor(async () => (await txByExternal(orm, 'rb-1')).status === 'PROCESSED');
        await waitFor(async () => (await counterTotal(fx.metrics.pendingReferences)) === 1);
      } finally {
        await fx.worker.stop();
      }
      expect((fx.worker as unknown as { loop?: unknown }).loop).toBeUndefined();
      await expectLedgerConsistent(orm, wallet.walletId);
    });

    it('shutdown no meio de uma candidata: ela commita, a seguinte não é tocada', async () => {
      const wallet = await seedWallet(orm, '100.00');
      for (const n of [1, 2]) {
        await submit(wallet, { externalTransactionId: `rb-${n}`, kind: 'ROLLBACK', referenceExternalTransactionId: `bet-${n}`, money: brl('10.00') });
        await submit(wallet, { externalTransactionId: `bet-${n}`, money: brl('10.00') });
      }
      const entered = deferred();
      const gate = deferred();
      const worker = new PendingReferenceWorker(
        {
          findDue: (limit) => fx.resolver.findDue(limit),
          countPending: () => fx.resolver.countPending(),
          fail: (candidate) => fx.resolver.fail(candidate),
          resolve: async (candidate) => {
            entered.resolve();
            await gate.promise;
            return fx.resolver.resolve(candidate);
          },
        },
        fx.metrics,
        TEST_WORKER_OPTIONS,
      );

      worker.start();
      await entered.promise;
      const stopping = worker.stop();
      gate.resolve();
      await stopping;

      const statuses = [(await txByExternal(orm, 'rb-1')).status, (await txByExternal(orm, 'rb-2')).status].sort();
      expect(statuses).toEqual(['PENDING_REFERENCE', 'PROCESSED']);
      await expectLedgerConsistent(orm, wallet.walletId);
    });
  });
});

/** Espera uma condição com prazo curto (sem sleep fixo no teste). */
async function waitFor(check: () => Promise<boolean>, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error('condição não atingida no prazo');
    await Bun.sleep(20);
  }
}
