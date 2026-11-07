import { describe, expect, test } from 'bun:test';
import { InvalidLedgerEntryError } from '../../../src/domain/errors';
import { Money } from '../../../src/domain/money';
import {
  LedgerDirection,
  WalletLedgerEntry,
  type CreateLedgerEntryProps,
} from '../../../src/domain/wallet-ledger-entry';
import { T0, brl } from './fixtures';

const props = (overrides: Partial<CreateLedgerEntryProps> = {}): CreateLedgerEntryProps => ({
  id: 'entry-1',
  walletId: 'wallet-1',
  transactionId: 'tx-1',
  direction: LedgerDirection.Debit,
  money: brl('30.00'),
  balanceBefore: brl('100.00'),
  balanceAfter: brl('70.00'),
  createdAt: T0,
  ...overrides,
});

describe('WalletLedgerEntry.create — aritmética', () => {
  test('DEBIT: before − money = after', () => {
    expect(WalletLedgerEntry.create(props()).isBalanced()).toBe(true);
  });

  test('CREDIT: before + money = after', () => {
    const entry = WalletLedgerEntry.create(
      props({ direction: LedgerDirection.Credit, balanceAfter: brl('130.00') }),
    );
    expect(entry.isBalanced()).toBe(true);
  });

  test.each([
    ['saldo final errado', props({ balanceAfter: brl('71.00') })],
    ['direção trocada', props({ direction: LedgerDirection.Credit })],
    ['valor zero', props({ money: brl('0'), balanceAfter: brl('100.00') })],
    ['saldo final negativo', props({ balanceBefore: brl('10.00'), balanceAfter: brl('10.00').subtract(brl('30.00')) })],
    ['moeda divergente', props({ money: Money.from({ amount: '30.00', currency: 'USD' }) })],
  ])('rejeita %s', (_label, invalid) => {
    expect(() => WalletLedgerEntry.create(invalid)).toThrow(InvalidLedgerEntryError);
  });
});

describe('WalletLedgerEntry — imutabilidade', () => {
  test('a instância é congelada', () => {
    const entry = WalletLedgerEntry.create(props());
    expect(Object.isFrozen(entry)).toBe(true);
    expect(() => {
      (entry as unknown as { balanceAfter: Money }).balanceAfter = brl('0');
    }).toThrow(TypeError);
  });

  test('rehydrate não revalida', () => {
    const entry = WalletLedgerEntry.rehydrate(props({ balanceAfter: brl('1.00') }));
    expect(entry.isBalanced()).toBe(false);
  });
});
