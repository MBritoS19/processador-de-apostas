import { Catch, HttpException, type ArgumentsHost, type ExceptionFilter } from '@nestjs/common';
import type { Request, Response } from 'express';
import { TransientPersistenceError } from '../../application/ports/wager-unit-of-work';
import { rootLogger } from '../../infrastructure/observability/logger';
import { translatePersistenceError } from '../../infrastructure/persistence/mikro-orm-wager-unit-of-work';
import { ensureCorrelationId } from './correlation.middleware';

/** Códigos estáveis do envelope de erro (ARCHITECTURE.md → "API HTTP"). */
export type ApiErrorCode =
  | 'INVALID_INPUT'
  | 'NOT_FOUND'
  | 'IDEMPOTENCY_CONFLICT'
  | 'WALLET_ALREADY_EXISTS'
  | 'TRANSIENT_FAILURE'
  | 'REQUEST_ERROR'
  | 'INTERNAL_ERROR';

/** Erro de borda renderizado como `{ error: { code, message, ...details } }`. */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: ApiErrorCode,
    message: string,
    readonly details: Record<string, unknown> = {},
    readonly headers: Record<string, string> = {},
  ) {
    super(message);
    this.name = 'ApiError';
  }

  static invalidInput(message: string): ApiError {
    return new ApiError(400, 'INVALID_INPUT', message);
  }

  static notFound(message: string): ApiError {
    return new ApiError(404, 'NOT_FOUND', message);
  }

  /** Única resposta com 503: o cliente pode reenviar a mesma requisição. */
  static transient(): ApiError {
    return new ApiError(503, 'TRANSIENT_FAILURE', 'falha transitória; reenvie a requisição', {}, { 'Retry-After': '1' });
  }
}

const logger = rootLogger.child({ name: 'HttpErrors' });

/**
 * Filtro global: todo erro (inclusive JSON malformado, rota desconhecida e 500) sai no mesmo
 * envelope. Mensagens do banco nunca chegam ao cliente; falha transitória do banco vira 503.
 */
@Catch()
export class ApiExceptionFilter implements ExceptionFilter {
  catch(exception: unknown, host: ArgumentsHost): void {
    const http = host.switchToHttp();
    const response = http.getResponse<Response>();
    const correlationId = ensureCorrelationId(http.getRequest<Request>(), response);
    const error = toApiError(exception, correlationId);
    for (const [name, value] of Object.entries(error.headers)) response.setHeader(name, value);
    response.status(error.status).json({ error: { code: error.code, message: error.message, ...error.details } });
  }
}

function toApiError(exception: unknown, correlationId: string): ApiError {
  if (exception instanceof ApiError) return exception;
  if (exception instanceof HttpException) {
    const status = exception.getStatus();
    if (status === 404) return ApiError.notFound('rota não encontrada');
    if (status === 400) return ApiError.invalidInput('corpo da requisição inválido');
    if (status < 500) return new ApiError(status, 'REQUEST_ERROR', 'requisição recusada');
  }
  if (translatePersistenceError(exception) instanceof TransientPersistenceError) return ApiError.transient();
  const { name, code } = (exception ?? {}) as { name?: unknown; code?: unknown };
  logger.error(
    {
      event: 'http_unhandled_error',
      correlationId,
      errorName: typeof name === 'string' ? name : typeof exception,
      ...(typeof code === 'string' ? { errorCode: code } : {}),
    },
    'unhandled error',
  );
  return new ApiError(500, 'INTERNAL_ERROR', 'erro interno');
}
