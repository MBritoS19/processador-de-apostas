import { Inject, Injectable } from '@nestjs/common';
import { MikroORM } from '@mikro-orm/postgresql';
import { DependencyUnreachableError, type ReadinessCheck } from '../../application/ports/readiness-check';
import { APP_CONFIG, type AppConfig } from '../config/app-config';
import { isNetworkError } from '../network-errors';

@Injectable()
export class PostgresReadinessCheck implements ReadinessCheck {
  readonly name = 'postgres';

  constructor(
    private readonly orm: MikroORM,
    @Inject(APP_CONFIG) private readonly config: Pick<AppConfig, 'healthCheckTimeoutMs'>,
  ) {}

  async check(signal: AbortSignal): Promise<void> {
    signal.throwIfAborted();
    try {
      // Timeout com cancel: o Postgres cancela a query (pg_cancel_backend) e a conexão
      // volta ao pool, em vez de ficar presa depois que o /health/ready já respondeu.
      // Acesso direto ao knex: não toca o identity map, compatível com allowGlobalContext=false.
      await this.orm.em
        .getKnex()
        .raw('select 1')
        .timeout(this.config.healthCheckTimeoutMs, { cancel: true });
    } catch (error: unknown) {
      if (isNetworkError(error) || isPoolAcquireTimeout(error)) {
        throw new DependencyUnreachableError(this.name, { cause: error });
      }
      throw error;
    }
  }
}

function isPoolAcquireTimeout(error: unknown): boolean {
  return error instanceof Error && error.name === 'KnexTimeoutError' && /acquiring a connection/i.test(error.message);
}
