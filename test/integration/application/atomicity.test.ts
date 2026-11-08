import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import type { MikroORM } from '@mikro-orm/postgresql';
import type { ProcessWagerTransactionResult } from '../../../src/application/wagering/process-wager-transaction';
import { T0, expectLedgerConsistent, openOrm, seedWallet, truncateAll } from '../persistence/db';
import { ManualClock } from '../workers/outbox-harness';
import { buildPendingFixture, counterTotal, entriesOf, txByExternal } from '../workers/pending-harness';
import { buildUseCase, command, countRows, walletBalance, type WalletRef } from './harness';

/**
 * Atomicidade (CHALLENGE §11, §13): wallet, transação, ledger, inbox e outbox são gravados no
 * mesmo commit. Um trigger REAL do Postgres (criado só dentro do teste) faz uma gravação
 * falhar no meio da transação; nada pode ter persistido, e reenviar a mesma requisição depois
 * funciona. Nada é mockado.
 */
describe('atomicidade wallet + ledger + inbox + outbox (Postgres real)', () => {
  let orm: MikroORM;
  let wallet: WalletRef;
  let useCase: ReturnType<typeof buildUseCase>['useCase'];
  const installed: string[] = [];

  const sql = (statement: string) => orm.em.getKnex().raw(statement);

  async function failOn(table: string, event: 'insert' | 'update'): Promise<void> {
    const name = `fail_${event}_${table}`;
    await sql(`create or replace function ${name}() returns trigger language plpgsql as $$
      begin raise exception 'falha injetada em ${table}' using errcode = 'XX000'; end $$`);
    await sql(`create trigger ${name} before ${event} on ${table} for each row execute function ${name}()`);
    installed.push(`${table}:${name}`);
  }

  async function healAll(): Promise<void> {
    for (const entry of installed.splice(0)) {
      const [table, name] = entry.split(':') as [string, string];
      await sql(`drop trigger if exists ${name} on ${table}`);
      await sql(`drop function if exists ${name}()`);
    }
  }

  beforeAll(async () => {
    orm = await openOrm();
  });

  beforeEach(async () => {
    await truncateAll(orm);
    wallet = await seedWallet(orm, '100.00');
    ({ useCase } = buildUseCase(orm));
  });

  afterEach(async () => {
    await healAll();
    await expectLedgerConsistent(orm, wallet.walletId);
  });

  afterAll(async () => {
    await orm.close(true);
  });

  async function expectNothingPersisted(): Promise<void> {
    expect(await walletBalance(orm, wallet.walletId)).toBe('100.00');
    expect(await countRows(orm, 'wager_transactions')).toBe(1); // só a OPENING do seed
    expect(await countRows(orm, 'wallet_ledger_entries')).toBe(1);
    expect(await countRows(orm, 'outbox_messages')).toBe(0);
    expect(await countRows(orm, 'inbox_messages')).toBe(0);
    const [row] = await orm.em.getKnex()('wallets').select('version').where({ id: wallet.walletId });
    expect(row.version).toBe(1);
  }

  async function expectFullyApplied(result: ProcessWagerTransactionResult): Promise<void> {
    expect(result.type).toBe('Processed');
    expect(await walletBalance(orm, wallet.walletId)).toBe('90.00');
    expect(await countRows(orm, 'wager_transactions')).toBe(2);
    expect(await countRows(orm, 'wallet_ledger_entries')).toBe(2);
    expect(await countRows(orm, 'outbox_messages')).toBe(2); // Processed + WalletBalanceChanged
    expect(await countRows(orm, 'inbox_messages')).toBe(1);
  }

  it.each([
    ['wager_transactions', 'insert'],
    ['wallets', 'update'],
    ['wallet_ledger_entries', 'insert'],
    ['outbox_messages', 'insert'],
    ['inbox_messages', 'insert'],
  ] as const)('falha na gravação de %s (%s) → nada persiste; o reenvio idêntico aplica tudo uma vez', async (table, event) => {
    const cmd = command(wallet, { externalTransactionId: 'atomic-1' }, {
      inbox: { consumerName: 'atomicity-test', messageId: 'msg-atomic-1', payloadHash: 'hash-atomic-1' },
    });

    await failOn(table, event);
    const outcome = await useCase.execute(cmd).then(
      (result) => result,
      (error: unknown) => error,
    );
    // Falha inesperada: ou lança (bug) ou volta como transitória. Nunca Processed.
    expect((outcome as { type?: string }).type).not.toBe('Processed');
    await expectNothingPersisted();

    await healAll();
    await expectFullyApplied(await useCase.execute(cmd));

    // E o reenvio seguinte continua sendo replay: nenhum efeito novo.
    const replay = await useCase.execute(cmd);
    expect(replay.type).toBe('Processed');
    await expectFullyApplied(replay);
  });

  it.each([
    ['wager_transactions', 'update'],
    ['wallets', 'update'],
    ['wallet_ledger_entries', 'insert'],
    ['outbox_messages', 'insert'],
  ] as const)(
    'resolução pelo worker de pendentes: falha na gravação de %s (%s) → continua PENDING_REFERENCE, saldo e ledger intactos; depois aplica uma vez',
    async (table, event) => {
      const fx = buildPendingFixture(orm, new ManualClock(T0));
      const rollback = { externalTransactionId: 'rb-1', kind: 'ROLLBACK', referenceExternalTransactionId: 'bet-1', money: { amount: '30.00', currency: 'BRL' } };
      expect((await fx.useCase.execute(command(wallet, rollback))).type).toBe('PendingReference');
      // A BET chega e antecipa a pendente (caminho rápido): ela fica vencida para o worker.
      expect((await fx.useCase.execute(command(wallet, { externalTransactionId: 'bet-1', money: { amount: '30.00', currency: 'BRL' } }))).type).toBe('Processed');
      const before = await snapshot();
      expect(before).toMatchObject({ balance: '70.00', version: 2, ledger: 2 });
      const pendingBefore = await txByExternal(orm, 'rb-1');
      expect(pendingBefore.status).toBe('PENDING_REFERENCE');

      await failOn(table, event);
      expect(await fx.worker.runOnce(), 'a candidata foi tentada e não avançou').toEqual({ candidates: 1, progressed: 0 });
      expect(await counterTotal(fx.metrics.pendingReferenceSkipped, { reason: 'error' }), 'falha inesperada contada').toBe(1);
      const rb = await txByExternal(orm, 'rb-1');
      expect(rb, 'nada da resolução persistiu na transação (linha idêntica à de antes)').toEqual(pendingBefore);
      expect(await snapshot(), 'saldo, version, ledger e outbox iguais aos de antes').toEqual(before);

      await healAll();
      expect(await fx.worker.runOnce()).toEqual({ candidates: 1, progressed: 1 });
      expect(await txByExternal(orm, 'rb-1')).toMatchObject({ status: 'PROCESSED', observed_balance: '100.00' });
      const after = await snapshot();
      expect(after).toEqual({
        balance: '100.00',
        version: 3,
        ledger: 3,
        outbox: before.outbox + 2, // WagerTransactionProcessed + WalletBalanceChanged
      });
      expect(await entriesOf(orm, rb.id)).toBe(1);
      // Nada mais a resolver: um novo ciclo não muda nada.
      expect(await fx.worker.runOnce()).toEqual({ candidates: 0, progressed: 0 });
      expect(await snapshot()).toEqual(after);
    },
  );

  async function snapshot(): Promise<{ balance: string; version: number; ledger: number; outbox: number }> {
    const [row] = await orm.em.getKnex()('wallets').select('balance', 'version').where({ id: wallet.walletId });
    return {
      balance: row.balance as string,
      version: Number(row.version),
      ledger: await countRows(orm, 'wallet_ledger_entries'),
      outbox: await countRows(orm, 'outbox_messages'),
    };
  }

  it('falha só no 2º insert da outbox (WalletBalanceChanged): o débito e o 1º evento também somem', async () => {
    // O trigger deixa o 1º insert passar e derruba o seguinte, dentro da mesma transação.
    await sql(`create or replace function fail_second_outbox() returns trigger language plpgsql as $$
      begin
        if (select count(*) from outbox_messages) >= 1 then
          raise exception 'falha injetada no 2º evento' using errcode = 'XX000';
        end if;
        return new;
      end $$`);
    await sql(`create trigger fail_second_outbox before insert on outbox_messages for each row execute function fail_second_outbox()`);
    installed.push('outbox_messages:fail_second_outbox');

    const cmd = command(wallet, { externalTransactionId: 'atomic-2' });
    const outcome = await useCase.execute(cmd).then(
      (result) => result,
      (error: unknown) => error,
    );
    expect((outcome as { type?: string }).type).not.toBe('Processed');
    expect(await walletBalance(orm, wallet.walletId)).toBe('100.00');
    expect(await countRows(orm, 'outbox_messages')).toBe(0);
    expect(await countRows(orm, 'wallet_ledger_entries')).toBe(1);
    expect(await countRows(orm, 'wager_transactions')).toBe(1);

    await healAll();
    expect((await useCase.execute(cmd)).type).toBe('Processed');
    expect(await countRows(orm, 'outbox_messages')).toBe(2);
    expect(await walletBalance(orm, wallet.walletId)).toBe('90.00');
  });
});
