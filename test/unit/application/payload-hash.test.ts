import { describe, expect, it } from 'bun:test';
import { createHash } from 'node:crypto';
import { canonicalJson, wagerPayloadHash, type HashablePayload } from '../../../src/application/wagering/payload-hash';
import { Money } from '../../../src/domain/money';

const base: HashablePayload = {
  providerId: 'provider-a',
  externalTransactionId: 'transaction-123',
  playerId: 'player-1',
  walletId: '0192f291-27dd-7d3f-8071-5f8685deef37',
  roundId: 'round-987',
  gameId: 'fortune-chimp',
  kind: 'BET',
  money: Money.from({ amount: '25.00', currency: 'BRL' }),
};

describe('canonicalJson', () => {
  it('ordena as chaves recursivamente e não tem espaços', () => {
    expect(canonicalJson({ b: 1, a: { d: [2, { z: null, y: 'x' }], c: true } })).toBe(
      '{"a":{"c":true,"d":[2,{"y":"x","z":null}]},"b":1}',
    );
  });

  it('escapa strings como JSON', () => {
    expect(canonicalJson({ 'k"': 'a"b\n' })).toBe('{"k\\"":"a\\"b\\n"}');
  });
});

describe('wagerPayloadHash', () => {
  it('é o SHA-256 hex do JSON canônico documentado', () => {
    const expected =
      '{"externalTransactionId":"transaction-123","gameId":"fortune-chimp","kind":"BET",' +
      '"money":{"amount":"25.00","currency":"BRL"},"playerId":"player-1","providerId":"provider-a",' +
      '"referenceExternalTransactionId":null,"roundId":"round-987","walletId":"0192f291-27dd-7d3f-8071-5f8685deef37"}';
    expect(wagerPayloadHash(base)).toBe(createHash('sha256').update(expected).digest('hex'));
    expect(wagerPayloadHash(base)).toMatch(/^[0-9a-f]{64}$/);
  });

  it('normaliza o valor: "25" e "25.00" geram o mesmo hash', () => {
    expect(wagerPayloadHash({ ...base, money: Money.from({ amount: '25', currency: 'BRL' }) })).toBe(wagerPayloadHash(base));
  });

  it('não depende da ordem das propriedades na entrada', () => {
    const reversed = Object.fromEntries(Object.entries(base).reverse()) as unknown as HashablePayload;
    expect(wagerPayloadHash(reversed)).toBe(wagerPayloadHash(base));
  });

  it('ignora campos que não são de negócio', () => {
    const withExtras = { ...base, idempotencyKey: 'k', correlationId: 'c' } as HashablePayload;
    expect(wagerPayloadHash(withExtras)).toBe(wagerPayloadHash(base));
  });

  it.each([
    ['providerId', { providerId: 'provider-b' }],
    ['externalTransactionId', { externalTransactionId: 'other' }],
    ['playerId', { playerId: 'p2' }],
    ['walletId', { walletId: '0192f291-27dd-7d3f-8071-5f8685deef38' }],
    ['roundId', { roundId: 'r2' }],
    ['gameId', { gameId: 'g2' }],
    ['kind', { kind: 'WIN' }],
    ['amount', { money: Money.from({ amount: '25.01', currency: 'BRL' }) }],
    ['currency', { money: Money.from({ amount: '25.00', currency: 'USD' }) }],
    ['referenceExternalTransactionId', { referenceExternalTransactionId: 'ref' }],
  ])('muda quando %s muda', (_, change) => {
    expect(wagerPayloadHash({ ...base, ...change })).not.toBe(wagerPayloadHash(base));
  });
});
