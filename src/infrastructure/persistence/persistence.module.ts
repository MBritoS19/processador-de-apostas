import { Module, type DynamicModule } from '@nestjs/common';
import { MikroOrmModule } from '@mikro-orm/nestjs';
import type { AppConfig } from '../config/app-config';
import { buildMikroOrmConfig } from './mikro-orm.config';
import { PostgresReadinessCheck } from './postgres-readiness.check';

@Module({})
export class PersistenceModule {
  static register(config: AppConfig): DynamicModule {
    return {
      module: PersistenceModule,
      imports: [
        MikroOrmModule.forRoot({
          ...buildMikroOrmConfig(config),
          // Conexão preguiçosa: a instância sobe mesmo com o Postgres fora e o /health/ready
          // reporta not_ready, em vez de entrar em crash loop durante uma queda do banco.
          connect: false,
          // Sem contexto implícito por request: HTTP, consumidor SQS e workers seguem a mesma
          // regra — todo use case abre o próprio contexto (em.fork / transactional).
          registerRequestContext: false,
        }),
      ],
      providers: [PostgresReadinessCheck],
      exports: [PostgresReadinessCheck],
    };
  }
}
