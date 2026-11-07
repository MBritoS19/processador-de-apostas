import { describe, expect, test } from 'bun:test';
import { CurrencyMismatchError, InvalidMoneyError } from '../../../src/domain/errors';
import { Money, type MoneyProps } from '../../../src/domain/money';
import { brl } from './fixtures';

const usd = (amount: string): Money => Money.from({ amount, currency: 'USD' });

describe('Money.from — escala', () => {
  test.each([
    ['25', '25.00'],
    ['25.5', '25.50'],
    ['25.05', '25.05'],
    ['0', '0.00'],
    ['0.01', '0.01'],
    ['999999999999999999.99', '999999999999999999.99'],
  ])('"%s" é serializado como "%s"', (input, expected) => {
    expect(brl(input).amount).toBe(expected);
    expect(brl(input).toJSON()).toEqual({ amount: expected, currency: 'BRL' });
  });

  test('toString inclui a moeda', () => {
    expect(brl('7.1').toString()).toBe('7.10 BRL');
  });
});

describe('Money.from — entradas inválidas', () => {
  test.each([
    ['vazio', ''],
    ['espaços', ' 1.00 '],
    ['NaN', 'NaN'],
    ['Infinity', 'Infinity'],
    ['-Infinity', '-Infinity'],
    ['notação científica', '1e3'],
    ['notação científica maiúscula', '1E-2'],
    ['mais de 2 casas', '1.001'],
    ['negativo', '-1.00'],
    ['sinal positivo', '+1.00'],
    ['ponto sem casas', '1.'],
    ['sem parte inteira', '.50'],
    ['vírgula decimal', '1,00'],
    ['zeros à esquerda', '007.00'],
    ['hexadecimal', '0x10'],
    ['separador de milhar', '1_000'],
    ['19 dígitos inteiros', '1000000000000000000'],
  ])('%s: "%s"', (_label, amount) => {
    expect(() => brl(amount)).toThrow(InvalidMoneyError);
  });

  test('rejeita amount que não é string (number em runtime)', () => {
    const props = { amount: 25, currency: 'BRL' } as unknown as MoneyProps;
    expect(() => Money.from(props)).toThrow(InvalidMoneyError);
  });

  test.each(['', 'brl', 'BR', 'BRLX', '123'])('rejeita moeda "%s"', (currency) => {
    expect(() => Money.from({ amount: '1.00', currency })).toThrow(InvalidMoneyError);
    expect(() => Money.zero(currency)).toThrow(InvalidMoneyError);
  });
});

describe('Money — operações', () => {
  test('add e subtract são exatos (sem erro de ponto flutuante)', () => {
    expect(brl('0.10').add(brl('0.20')).amount).toBe('0.30');
    expect(brl('100.00').subtract(brl('80.00')).amount).toBe('20.00');
    expect(brl('999999999999999998.99').add(brl('1.00')).amount).toBe('999999999999999999.99');
  });

  test('subtract e negate podem produzir negativo', () => {
    const negative = brl('1.00').subtract(brl('1.50'));
    expect(negative.amount).toBe('-0.50');
    expect(negative.isNegative()).toBe(true);
    expect(brl('2.00').negate().amount).toBe('-2.00');
    expect(negative.negate().equals(brl('0.50'))).toBe(true);
  });

  test('é imutável: operações retornam nova instância', () => {
    const a = brl('10.00');
    const b = a.add(brl('5.00'));
    expect(a.amount).toBe('10.00');
    expect(b).not.toBe(a);
    expect(Object.isFrozen(a)).toBe(true);
  });

  test('predicados', () => {
    expect(Money.zero('BRL').isZero()).toBe(true);
    expect(brl('0.01').isPositive()).toBe(true);
    expect(brl('0.00').isPositive()).toBe(false);
    expect(brl('1.00').isLessThan(brl('1.01'))).toBe(true);
    expect(brl('1.01').isLessThan(brl('1.01'))).toBe(false);
    expect(brl('25').equals(brl('25.00'))).toBe(true);
  });

  test('overflow além de numeric(20,2) lança erro', () => {
    expect(() => brl('999999999999999999.99').add(brl('0.01'))).toThrow(InvalidMoneyError);
  });
});

describe('Money — conflito de moeda', () => {
  test.each([
    ['add', (a: Money, b: Money) => a.add(b)],
    ['subtract', (a: Money, b: Money) => a.subtract(b)],
    ['isLessThan', (a: Money, b: Money) => a.isLessThan(b)],
  ])('%s entre moedas diferentes lança CurrencyMismatchError', (_name, op) => {
    expect(() => op(brl('1.00'), usd('1.00'))).toThrow(CurrencyMismatchError);
  });

  test('equals entre moedas diferentes é false', () => {
    expect(brl('1.00').equals(usd('1.00'))).toBe(false);
  });
});
