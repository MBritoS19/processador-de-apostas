import { describe, expect, it } from 'bun:test';
import { createHash } from 'node:crypto';
import { canonicalJson, wagerPayloadHashOfRaw } from '../../../src/application/wagering/payload-hash';
import { parseEnvelope, type WagerEnvelope } from '../../../src/interfaces/sqs/wager-envelope';
import { errorPauseMs } from '../../../src/interfaces/error-pause';
import { retryDelaySeconds } from '../../../src/interfaces/sqs/wager-consumer';

const data = {
  providerId: 'provider-a',
  externalTransactionId: 'transaction-123',
  idempotencyKey: 'provider-a:transaction-123',
  playerId: 'player-1',
  walletId: '0192f291-27dd-7d3f-8071-5f8685deef37',
  roundId: 'round-987',
  gameId: 'fortune-chimp',
  kind: 'BET',
  money: { amount: '25.00', currency: 'BRL' },
};

const envelope = (overrides: Record<string, unknown> = {}) =>
  JSON.stringify({
    messageId: 'msg-123',
    type: 'WagerTransactionRequested',
    occurredAt: '2026-07-29T15:00:00.000Z',
    data,
    ...overrides,
  });

const parsed = (body: string): WagerEnvelope => {
  const result = parseEnvelope(body);
  if (typeof result === 'string') throw new Error(result);
  return result;
};

describe('parseEnvelope', () => {
  it('aceita o envelope do CHALLENGE §10 e tira a key de data.idempotencyKey', () => {
    const result = parsed(envelope());
    expect(result.messageId).toBe('msg-123');
    expect(result.idempotencyKey).toBe('provider-a:transaction-123');
    expect(result.data.kind).toBe('BET');
    expect(result.payloadHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('correlationId: o do envelope quando válido, senão o messageId', () => {
    expect(parsed(envelope()).correlationId).toBe('msg-123');
    expect(parsed(envelope({ correlationId: 'corr-9' })).correlationId).toBe('corr-9');
    expect(parsed(envelope({ correlationId: 'com espaço\n' })).correlationId).toBe('msg-123');
  });

  it('hash cobre só type + data: messageId e occurredAt não mudam o hash', () => {
    const base = parsed(envelope()).payloadHash;
    expect(parsed(envelope({ messageId: 'outro', occurredAt: '2026-01-01T00:00:00Z' })).payloadHash).toBe(base);
    expect(parsed(envelope({ correlationId: 'x' })).payloadHash).toBe(base);
    // chaves em outra ordem: mesmo JSON canônico
    const reordered = JSON.stringify({ data: Object.fromEntries(Object.entries(data).reverse()), type: 'WagerTransactionRequested', occurredAt: '2026-07-29T15:00:00.000Z', messageId: 'm' });
    expect(parsed(reordered).payloadHash).toBe(base);
    expect(parsed(envelope({ data: { ...data, money: { amount: '26.00', currency: 'BRL' } } })).payloadHash).not.toBe(base);
  });

  it('hash da inbox usa a normalização da transação: "25" × "25.00", walletId em maiúsculas e referência null', () => {
    const base = parsed(envelope()).payloadHash;
    expect(parsed(envelope({ data: { ...data, money: { amount: '25', currency: 'BRL' } } })).payloadHash).toBe(base);
    expect(parsed(envelope({ data: { ...data, walletId: data.walletId.toUpperCase() } })).payloadHash).toBe(base);
    expect(parsed(envelope({ data: { ...data, referenceExternalTransactionId: null } })).payloadHash).toBe(base);
    // Campos fora do payload de negócio não entram (como no hash da transação).
    expect(parsed(envelope({ data: { ...data, extra: 'x' } })).payloadHash).toBe(base);
  });

  it('hash da inbox: o normalizado da transação + a idempotency key', () => {
    const { idempotencyKey: _key, ...business } = data;
    expect(parsed(envelope()).payloadHash).toBe(
      createHash('sha256').update(canonicalJson({ idempotencyKey: data.idempotencyKey, payloadHash: wagerPayloadHashOfRaw(business)! }), 'utf8').digest('hex'),
    );
    // A mesma mensagem com outra key é outra mensagem.
    expect(parsed(envelope({ data: { ...data, idempotencyKey: 'provider-a:outra' } })).payloadHash).not.toBe(parsed(envelope()).payloadHash);
  });

  it('payload não normalizável (o use case rejeitaria): hash do JSON cru, diferente do de qualquer payload válido', () => {
    const invalid = parsed(envelope({ data: { ...data, money: { amount: '25,00', currency: 'BRL' } } })).payloadHash;
    expect(invalid).toMatch(/^[0-9a-f]{64}$/);
    expect(invalid).not.toBe(parsed(envelope()).payloadHash);
  });

  it.each([
    ['não é JSON', '{', 'corpo não é JSON'],
    ['array', '[]', 'envelope deve ser um objeto'],
    ['sem messageId', envelope({ messageId: undefined }), 'messageId é obrigatório'],
    ['messageId vazio', envelope({ messageId: ' ' }), 'messageId não pode ser vazio'],
    ['messageId longo', envelope({ messageId: 'x'.repeat(257) }), 'messageId excede 256 caracteres'],
    ['type errado', envelope({ type: 'Outro' }), 'type deve ser WagerTransactionRequested'],
    ['sem occurredAt', envelope({ occurredAt: undefined }), 'occurredAt deve ser uma data ISO 8601'],
    ['occurredAt sem fuso', envelope({ occurredAt: '2026-07-29T15:00:00' }), 'occurredAt deve ser uma data ISO 8601'],
    ['occurredAt impossível', envelope({ occurredAt: '2026-13-40T15:00:00Z' }), 'occurredAt deve ser uma data ISO 8601'],
    ['data ausente', envelope({ data: null }), 'data deve ser um objeto'],
    ['sem idempotencyKey', envelope({ data: { ...data, idempotencyKey: undefined } }), 'data.idempotencyKey é obrigatório'],
    ['idempotencyKey numérica', envelope({ data: { ...data, idempotencyKey: 1 } }), 'data.idempotencyKey deve ser texto'],
  ])('rejeita %s', (_, body, reason) => {
    expect(parseEnvelope(body)).toBe(reason);
  });
});

describe('backoff do consumidor', () => {
  it('retry: 30·2^(n−1) com teto 300 (30/60/120/240/300)', () => {
    expect([1, 2, 3, 4, 5, 6].map((n) => retryDelaySeconds(n, 30, 300))).toEqual([30, 60, 120, 240, 300, 300]);
    expect(retryDelaySeconds(10_000, 30, 300)).toBe(300);
    expect(retryDelaySeconds(3, 0, 0)).toBe(0);
  });

  it('pausa do polling: 1s·2^(n−1) até 30s', () => {
    expect([1, 2, 3, 4, 5, 6, 7].map(errorPauseMs)).toEqual([1000, 2000, 4000, 8000, 16000, 30000, 30000]);
  });
});
