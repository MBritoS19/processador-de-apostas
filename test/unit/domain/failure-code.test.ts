import { expect, test } from 'bun:test';
import { FailureCode } from '../../../src/domain/failure-code';

/** Os códigos são contrato público: este teste quebra se algum for renomeado ou removido. */
test('taxonomia de FailureCode é estável e sem duplicatas', () => {
  const values: string[] = Object.values(FailureCode);
  expect(new Set(values).size).toBe(values.length);
  expect(values.sort()).toEqual([
    'AMOUNT_MISMATCH',
    'BALANCE_LIMIT_EXCEEDED',
    'CURRENCY_MISMATCH',
    'INFRASTRUCTURE_FAILURE',
    'INSUFFICIENT_BALANCE',
    'INVALID_REFERENCE_KIND',
    'REFERENCE_ALREADY_REVERSED',
    'REFERENCE_NOT_FOUND',
    'REFERENCE_NOT_PROCESSED',
    'REFERENCE_PLAYER_MISMATCH',
    'REFERENCE_ROUND_MISMATCH',
    'REFERENCE_WALLET_MISMATCH',
    'REVERSAL_WOULD_OVERDRAW',
    'WALLET_NOT_FOUND',
    'WALLET_PLAYER_MISMATCH',
  ]);
});

test('saldo insuficiente em BET e reversão que deixaria saldo negativo são códigos distintos', () => {
  expect(FailureCode.InsufficientBalance).not.toBe(FailureCode.ReversalWouldOverdraw);
});
