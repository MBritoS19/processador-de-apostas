import type { LoggerService } from '@nestjs/common';
import pino, { type Logger } from 'pino';

/** Logger raiz (JSON, uma linha por evento). Cada componente usa um `child({ name })`. */
export const rootLogger: Logger = pino({ level: process.env.LOG_LEVEL ?? 'info' });

/** Nome do erro para o campo `errorName` dos logs (nunca a mensagem, que pode carregar dados). */
export function errorName(error: unknown): string {
  return error instanceof Error ? error.name : typeof error;
}

/** Adapta o logger do Nest (boot, rotas, erros do framework) ao mesmo JSON do resto. */
export class PinoNestLogger implements LoggerService {
  private readonly logger = rootLogger.child({ name: 'Nest' });

  log(message: unknown, context?: string): void {
    this.logger.info({ context }, String(message));
  }
  error(message: unknown, trace?: string, context?: string): void {
    this.logger.error({ context, trace }, String(message));
  }
  warn(message: unknown, context?: string): void {
    this.logger.warn({ context }, String(message));
  }
  debug(message: unknown, context?: string): void {
    this.logger.debug({ context }, String(message));
  }
  verbose(message: unknown, context?: string): void {
    this.logger.trace({ context }, String(message));
  }
}
