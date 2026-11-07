import { MiddlewareConsumer, Module, type DynamicModule, type NestModule } from '@nestjs/common';
import type { AppConfig } from './infrastructure/config/app-config';
import { ConfigModule } from './infrastructure/config/config.module';
import { MessagingModule } from './infrastructure/messaging/messaging.module';
import { PersistenceModule } from './infrastructure/persistence/persistence.module';
import { HealthModule } from './interfaces/http/health/health.module';
import { WageringModule } from './interfaces/http/wagering.module';
import { MetricsModule } from './interfaces/http/metrics.module';
import { WagerConsumerModule } from './interfaces/sqs/wager-consumer.module';
import { correlationMiddleware } from './interfaces/http/correlation.middleware';
import { ApiExceptionFilter } from './interfaces/http/api-error';
import { APP_FILTER } from '@nestjs/core';

/**
 * Módulo raiz: só compõe módulos. Recebe a config já validada, para que testes
 * possam subir a aplicação apontando para outro banco/fila sem mexer em process.env.
 */
@Module({})
export class AppModule implements NestModule {
  static register(config: AppConfig): DynamicModule {
    const persistence = PersistenceModule.register(config);
    return {
      module: AppModule,
      imports: [
        ConfigModule.register(config),
        persistence,
        MessagingModule,
        HealthModule.register(persistence),
        WageringModule,
        MetricsModule,
        WagerConsumerModule,
      ],
      providers: [{ provide: APP_FILTER, useClass: ApiExceptionFilter }],
    };
  }

  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(correlationMiddleware).forRoutes('*');
  }
}
