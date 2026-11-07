import { describe, expect, it } from 'bun:test';
import { isNetworkError } from '../../../src/infrastructure/network-errors';

const withCode = (code: string) => Object.assign(new Error('x'), { code });

describe('isNetworkError', () => {
  it.each(['ECONNREFUSED', 'ENOTFOUND', 'ETIMEDOUT', 'ECONNRESET', 'EHOSTUNREACH', 'ConnectionRefused'])(
    'reconhece o código %p',
    (code) => {
      expect(isNetworkError(withCode(code))).toBe(true);
    },
  );

  it('percorre cause e AggregateError', () => {
    expect(isNetworkError(new Error('wrapper', { cause: withCode('ECONNREFUSED') }))).toBe(true);
    expect(isNetworkError(new AggregateError([new Error('a'), withCode('ECONNREFUSED')]))).toBe(true);
  });

  it('não classifica outros erros como rede', () => {
    expect(isNetworkError(new Error('syntax error'))).toBe(false);
    expect(isNetworkError(withCode('42P01'))).toBe(false);
    expect(isNetworkError('ECONNREFUSED')).toBe(false);
    expect(isNetworkError(null)).toBe(false);
  });

  it('não entra em loop com cause circular', () => {
    const a: Error & { cause?: unknown } = new Error('a');
    a.cause = a;
    expect(isNetworkError(a)).toBe(false);
  });
});
