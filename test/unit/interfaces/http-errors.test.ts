import { describe, expect, it } from 'bun:test';
import { BadRequestException, NotFoundException, type ArgumentsHost } from '@nestjs/common';
import type { ProcessWagerTransactionResult } from '../../../src/application/wagering/process-wager-transaction';
import { ObservabilityMetrics } from '../../../src/infrastructure/observability/metrics';
import { ApiError, ApiExceptionFilter } from '../../../src/interfaces/http/api-error';
import { WageringHttpService } from '../../../src/interfaces/http/wagering-http.service';

/** Resposta express mínima para o filtro. */
function render(exception: unknown) {
  const headers: Record<string, unknown> = {};
  const out = { status: 0, body: undefined as unknown, headers };
  const response = {
    getHeader: (name: string) => headers[name],
    setHeader: (name: string, value: unknown) => void (headers[name] = value),
    status(code: number) {
      out.status = code;
      return this;
    },
    json(body: unknown) {
      out.body = body;
    },
  };
  const request = { header: () => undefined, headers: {} };
  const host = { switchToHttp: () => ({ getResponse: () => response, getRequest: () => request }) } as unknown as ArgumentsHost;
  new ApiExceptionFilter().catch(exception, host);
  return out;
}

describe('ApiExceptionFilter', () => {
  it('erro inesperado → 500 INTERNAL_ERROR sem vazar a mensagem do Postgres', () => {
    const out = render(Object.assign(new Error('duplicate key value violates unique constraint "x"'), { code: '23505' }));
    expect(out.status).toBe(500);
    expect(out.body).toEqual({ error: { code: 'INTERNAL_ERROR', message: 'erro interno' } });
    expect(out.headers['X-Correlation-Id']).toBeTruthy();
  });

  it.each(['55P03', '40P01', '40001'])('SQLSTATE transitório %s fora do use case → 503 com Retry-After', (code) => {
    const out = render(Object.assign(new Error('pg'), { code }));
    expect(out.status).toBe(503);
    expect(out.headers['Retry-After']).toBe('1');
    expect(out.body).toEqual({ error: { code: 'TRANSIENT_FAILURE', message: expect.any(String) } });
  });

  it('exceções do Nest (rota desconhecida, JSON malformado) saem no mesmo envelope', () => {
    expect(render(new NotFoundException('Cannot GET /x')).body).toEqual({ error: { code: 'NOT_FOUND', message: 'rota não encontrada' } });
    expect(render(new BadRequestException('Unexpected token')).body).toEqual({
      error: { code: 'INVALID_INPUT', message: 'corpo da requisição inválido' },
    });
  });
});

describe('WageringHttpService — mapeamento do resultado do use case', () => {
  const service = (result: ProcessWagerTransactionResult) =>
    new WageringHttpService({} as never, { execute: async () => result }, { execute: async () => ({ type: 'InvalidInput', reason: 'x' }) }, { execute: async () => ({ type: 'NotFound' }) }, new ObservabilityMetrics());
  const submit = (result: ProcessWagerTransactionResult) => service(result).submit('k', 'c', {});
  const rejection = (result: ProcessWagerTransactionResult) => submit(result).then(
    () => undefined,
    (error: unknown) => error as ApiError,
  );

  it('Processed → 200', async () => {
    expect((await submit({ type: 'Processed', transactionId: 't', status: 'PROCESSED' as never, balance: { amount: '1.00', currency: 'BRL' }, idempotentReplay: false })).status).toBe(200);
  });

  it.each(['REJECTED', 'FAILED'])('Rejected com %s → 422 com failureCode (503 só para transitório)', async (status) => {
    const result = await submit({ type: 'Rejected', transactionId: 't', status: status as never, failureCode: 'INSUFFICIENT_BALANCE' as never, idempotentReplay: true });
    expect(result.status).toBe(422);
    expect(result.body).toMatchObject({ status, failureCode: 'INSUFFICIENT_BALANCE', idempotentReplay: true });
  });

  it('PendingReference → 202 com nextReferenceCheckAt', async () => {
    const at = new Date('2026-11-07T12:00:05.000Z');
    const result = await submit({ type: 'PendingReference', transactionId: 't', status: 'PENDING_REFERENCE' as never, nextReferenceCheckAt: at, idempotentReplay: false });
    expect(result.status).toBe(202);
    expect(result.body.nextReferenceCheckAt).toBe(at.toISOString());
  });

  it('InvalidInput → 400, IdempotencyConflict → 409, TransientFailure → 503 com Retry-After', async () => {
    expect(await rejection({ type: 'InvalidInput', reason: 'x' })).toMatchObject({ status: 400, code: 'INVALID_INPUT' });
    expect(await rejection({ type: 'IdempotencyConflict', existingTransactionId: 't' })).toMatchObject({
      status: 409,
      code: 'IDEMPOTENCY_CONFLICT',
      details: { existingTransactionId: 't' },
    });
    expect(await rejection({ type: 'TransientFailure', reason: 'lock_timeout' })).toMatchObject({
      status: 503,
      code: 'TRANSIENT_FAILURE',
      headers: { 'Retry-After': '1' },
    });
  });
});
