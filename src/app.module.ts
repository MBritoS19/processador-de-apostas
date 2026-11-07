import { Module, type DynamicModule } from '@nestjs/common';
import type { AppConfig } from './infrastructure/config/app-config';
import { ConfigModule } from './infrastructure/config/config.module';
import { MessagingModule } from './infrastructure/messaging/messaging.module';
import { PersistenceModule } from './infrastructure/persistence/persistence.module';
import { HealthModule } from './interfaces/http/health/health.module';

/**
 * Módulo raiz: só compõe módulos. Recebe a config já validada, para que testes
 * possam subir a aplicação apontando para outro banco/fila sem mexer em process.env.
 */
@Module({})
export class AppModule {
  static register(config: AppConfig): DynamicModule {
    const persistence = PersistenceModule.register(config);
    return {
      module: AppModule,
      imports: [
        ConfigModule.register(config),
        persistence,
        MessagingModule,
        HealthModule.register(persistence),
      ],
    };
  }
}
