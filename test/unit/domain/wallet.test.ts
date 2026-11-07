import { describe, expect, test } from 'bun:test';
import {
  CurrencyMismatchError,
  InsufficientBalanceError,
  InvalidLedgerEntryError,
} from '../../../src/domain/errors';
import { Money } from '../../../src/domain/money';
import { Wallet } from '../../../src/domain/wallet';
import { LedgerDirection } from '../../../src/domain/wallet-ledger-entry';
import { T0, brl } from './fixtures';

const T1 = new Date('2026-11-07T12:01:00.000Z');

function open(initial = '100.00') {
  return Wallet.open({
    id: 'wallet-1',
    playerId: 'player-1',
    initialBalance: brl(initial),
    openingTransactionId: 'tx-opening',
    openingEntryId: 'entry-opening',
    at: T0,
  });
}

const movement = (amount: string) => ({
  entryId: 'entry-2',
  transactionId: 'tx-2',
  money: brl(amount),
  at: T1,
});

describe('Wallet.open', () => {
  test('abre com o saldo inicial, version 1 e lançamento OPENING de crédito', () => {
    const { wallet, openingEntry } = open('1000.00');
    expect(wallet.balance.amount).toBe('1000.00');
    expect(wallet.currency).toBe('BRL');
    expect(wallet.version).toBe(1);
    expect(wallet.createdAt).toEqual(T0);
    expect(openingEntry).toBeDefined();
    expect(openingEntry?.transactionId).toBe('tx-opening');
    expect(openingEntry?.direction).toBe(LedgerDirection.Credit);
    expect(openingEntry?.balanceBefore.amount).toBe('0.00');
    expect(openingEntry?.balanceAfter.amount).toBe('1000.00');
  });

  test('saldo inicial zero não gera lançamento', () => {
    const { wallet, openingEntry } = open('0');
    expect(wallet.balance.isZero()).toBe(true);
    expect(wallet.version).toBe(1);
    expect(openingEntry).toBeUndefined();
  });
});

describe('Wallet.debit / credit', () => {
  test('debit reduz o saldo, incrementa version e devolve o lançamento DEBIT', () => {
    const { wallet } = open();
    const entry = wallet.debit(movement('80.00'));
    expect(wallet.balance.amount).toBe('20.00');
    expect(wallet.version).toBe(2);
    expect(wallet.updatedAt).toEqual(T1);
    expect(entry.direction).toBe(LedgerDirection.Debit);
    expect(entry.walletId).toBe('wallet-1');
    expect(entry.transactionId).toBe('tx-2');
    expect(entry.balanceBefore.amount).toBe('100.00');
    expect(entry.balanceAfter.amount).toBe('20.00');
  });

  test('credit aumenta o saldo e devolve o lançamento CREDIT', () => {
    const { wallet } = open();
    const entry = wallet.credit(movement('50.50'));
    expect(wallet.balance.amount).toBe('150.50');
    expect(wallet.version).toBe(2);
    expect(entry.direction).toBe(LedgerDirection.Credit);
    expect(entry.isBalanced()).toBe(true);
  });

  test('debit do saldo inteiro deixa zero', () => {
    const { wallet } = open();
    wallet.debit(movement('100.00'));
    expect(wallet.balance.isZero()).toBe(true);
  });

  test('cenário 80 + 80: a segunda aposta falha e o estado não muda', () => {
    const { wallet } = open();
    wallet.debit(movement('80.00'));
    expect(() => wallet.debit(movement('80.00'))).toThrow(InsufficientBalanceError);
    expect(wallet.balance.amount).toBe('20.00');
    expect(wallet.version).toBe(2);
  });

  test('moeda diferente da wallet lança CurrencyMismatchError sem alterar estado', () => {
    const { wallet } = open();
    const usdMovement = { ...movement('1.00'), money: Money.from({ amount: '1.00', currency: 'USD' }) };
    expect(() => wallet.debit(usdMovement)).toThrow(CurrencyMismatchError);
    expect(() => wallet.credit(usdMovement)).toThrow(CurrencyMismatchError);
    expect(wallet.balance.amount).toBe('100.00');
    expect(wallet.version).toBe(1);
  });

  test('valor zero não gera lançamento nem muda version', () => {
    const { wallet } = open();
    expect(() => wallet.credit(movement('0.00'))).toThrow(InvalidLedgerEntryError);
    expect(() => wallet.debit(movement('0.00'))).toThrow(InvalidLedgerEntryError);
    expect(wallet.version).toBe(1);
  });

  test('version incrementa uma vez por movimentação', () => {
    const { wallet } = open();
    wallet.credit(movement('1.00'));
    wallet.debit(movement('2.00'));
    wallet.credit(movement('3.00'));
    expect(wallet.version).toBe(4);
    expect(wallet.balance.amount).toBe('102.00');
  });
});

describe('Wallet.rehydrate', () => {
  test('reconstrói o estado persistido sem revalidar', () => {
    const wallet = Wallet.rehydrate({
      id: 'wallet-9',
      playerId: 'player-9',
      currency: 'BRL',
      balance: brl('42.00'),
      version: 7,
      createdAt: T0,
      updatedAt: T1,
    });
    expect(wallet.balance.amount).toBe('42.00');
    expect(wallet.version).toBe(7);
    expect(wallet.updatedAt).toEqual(T1);
    wallet.debit(movement('2.00'));
    expect(wallet.version).toBe(8);
  });
});
