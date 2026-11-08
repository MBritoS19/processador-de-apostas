import { describe, expect, it } from 'bun:test';
import type { WalletReconciliationSnapshot } from '../../../src/application/ports/wallet-reconciliation-reader';
import { ReconcileWallet } from '../../../src/application/wallets/reconcile-wallet';

const TX = { walletId: 'wallet-1', kind: 'OPENING', status: 'PROCESSED', amount: '100.00', currency: 'BRL' };

/** Wallet com OPENING de 100 consistente; `overrides` adultera o que o teste precisar. */
const snapshot = (overrides: Partial<WalletReconciliationSnapshot> = {}): WalletReconciliationSnapshot => ({
  balance: '100.00',
  currency: 'BRL',
  journalBalance: '100.00',
  entries: [{ entryId: 'e-1', transactionId: 't-1', direction: 'CREDIT', amount: '100.00', currency: 'BRL', transaction: TX }],
  processed: [{ transactionId: 't-1', kind: 'OPENING', entries: 1 }],
  ...overrides,
});

const reconcile = (state: WalletReconciliationSnapshot | undefined) =>
  new ReconcileWallet({ read: async () => state }).execute('wallet-1');

describe('ReconcileWallet — diário de partidas dobradas', () => {
  it('diário = saldo = ledger: consistente, com journalBalance', async () => {
    expect(await reconcile(snapshot())).toMatchObject({
      journalBalance: { amount: '100.00', currency: 'BRL' },
      consistent: true,
      divergences: [],
    });
  });

  it('diário ≠ saldo guardado: JOURNAL_BALANCE_MISMATCH sozinho', async () => {
    expect(await reconcile(snapshot({ journalBalance: '90.00' }))).toMatchObject({
      journalBalance: { amount: '90.00' },
      consistent: false,
      divergenceCount: 1,
      divergences: [{ type: 'JOURNAL_BALANCE_MISMATCH' }],
    });
  });

  it('saldo guardado ≠ ledger e ≠ diário: as duas divergências', async () => {
    const result = await reconcile(snapshot({ balance: '70.00' }));
    expect(result).toMatchObject({ consistent: false, divergences: [{ type: 'BALANCE_MISMATCH' }, { type: 'JOURNAL_BALANCE_MISMATCH' }] });
  });

  it('diário acompanhando um saldo que diverge do ledger: só BALANCE_MISMATCH', async () => {
    const result = await reconcile(snapshot({ balance: '70.00', journalBalance: '70.00' }));
    expect(result).toMatchObject({ consistent: false, divergences: [{ type: 'BALANCE_MISMATCH' }] });
  });

  it('wallet de saldo zero sem conta PLAYER ("0.00"): consistente', async () => {
    expect(await reconcile(snapshot({ balance: '0.00', journalBalance: '0.00', entries: [], processed: [] }))).toMatchObject({
      journalBalance: { amount: '0.00', currency: 'BRL' },
      consistent: true,
    });
  });

  it('wallet inexistente: NotFound', async () => {
    expect(await reconcile(undefined)).toEqual({ type: 'NotFound' });
  });
});
