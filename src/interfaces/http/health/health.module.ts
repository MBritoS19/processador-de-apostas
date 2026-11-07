import { Logger, Module, type DynamicModule } from '@nestjs/common';
import { ReadinessService } from '../../../application/health/readiness.service';
import { READINESS_CHECKS, type ReadinessCheck } from '../../../application/ports/readiness-check';
import { APP_CONFIG, type AppConfig } from '../../../infrastructure/config/app-config';
import { MessagingModule } from '../../../infrastructure/messaging/messaging.module';
import { SqsReadinessCheck } from '../../../infrastructure/messaging/sqs-readiness.check';
import { PostgresReadinessCheck } from '../../../infrastructure/persistence/postgres-readiness.check';
import { HealthController } from './health.controller';

const logger = new Logger('Readiness');

const providers = [
  {
    provide: READINESS_CHECKS,
    useFactory: (...checks: ReadinessCheck[]): readonly ReadinessCheck[] => checks,
    inject: [PostgresReadinessCheck, SqsReadinessCheck],
  },
  {
    provide: ReadinessService,
    useFactory: (checks: readonly ReadinessCheck[], config: AppConfig) =>
      new ReadinessService(checks, config.healthCheckTimeoutMs, (dependency, reason, error) => {
        // Só tipo/código do erro: sem payload, sem credenciais.
        const { name, code } = (error ?? {}) as { name?: unknown; code?: unknown };
        logger.warn(`${dependency} down (${reason}) error=${String(name)} code=${String(code ?? '-')}`);
      }),
    inject: [READINESS_CHECKS, APP_CONFIG],
  },
];

/** Recebe o módulo de persistência já configurado (dinâmico) para obter o check do Postgres. */
@Module({})
export class HealthModule {
  static register(persistence: DynamicModule): DynamicModule {
    return {
      module: HealthModule,
      imports: [persistence, MessagingModule],
      controllers: [HealthController],
      providers,
    };
  }
}
