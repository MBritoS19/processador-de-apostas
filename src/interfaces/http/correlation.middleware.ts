import { randomUUID } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import { rootLogger } from '../../infrastructure/observability/logger';

const logger = rootLogger.child({ name: 'HTTP' });
/** Aceito do cliente só se for curto e sem caracteres de controle; senão é gerado um novo. */
const CORRELATION_ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;

/**
 * Lê `X-Correlation-Id` (ou gera um), grava na requisição e na resposta. Idempotente: também é
 * chamada pelo filtro de erros, para requisições que falham antes do middleware (JSON malformado).
 */
export function ensureCorrelationId(request: Request, response: Response): string {
  const existing = response.getHeader('X-Correlation-Id');
  if (typeof existing === 'string') return existing;
  const incoming = request.header('X-Correlation-Id')?.trim();
  const correlationId = incoming !== undefined && CORRELATION_ID_PATTERN.test(incoming) ? incoming : randomUUID();
  request.headers['x-correlation-id'] = correlationId;
  response.setHeader('X-Correlation-Id', correlationId);
  return correlationId;
}

export function correlationMiddleware(request: Request, response: Response, next: NextFunction): void {
  const correlationId = ensureCorrelationId(request, response);
  const startedAt = performance.now();
  response.on('finish', () => {
    logger.info(
      {
        correlationId,
        method: request.method,
        // Template da rota (ex.: /wallets/:id), não a URL com ids e query string.
        route: (request.route as { path?: string } | undefined)?.path ?? 'unmatched',
        statusCode: response.statusCode,
        durationMs: Math.round(performance.now() - startedAt),
      },
      'http request completed',
    );
  });
  next();
}
