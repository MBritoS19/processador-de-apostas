import {
  Inject,
  Module,
  type DynamicModule,
  type BeforeApplicationShutdown,
  type OnApplicationBootstrap,
} from '@nestjs/common';
import { SQSClient } from '@aws-sdk/client-sqs';
import { EntityManager } from '@mikro-orm/postgresql';
import { APP_CONFIG, type AppConfig } from '../../infrastructure/config/app-config';
import { MessagingModule } from '../../infrastructure/messaging/messaging.module';
import { InstrumentedProcessWagerTransaction } from '../../infrastructure/observability/instrumented-process-wager-transaction';
import { ObservabilityMetrics } from '../../infrastructure/observability/metrics';
import { PostgresReadinessCheck } from '../../infrastructure/persistence/postgres-readiness.check';
import { InboxLookup } from '../../infrastructure/sqs/inbox-lookup';
import { WagerQueueClient } from '../../infrastructure/sqs/wager-queue.client';
import { WageringCoreModule } from '../../infrastructure/wagering-core.module';
import { WagerConsumer } from './wager-consumer';

/**
 * Liga o consumidor quando `SQS_CONSUMER_ENABLED=true`. Para em `beforeApplicationShutdown`,
 * antes de o ORM e o cliente SQS fecharem (`onApplicationShutdown`).
 */
const providers = [
    {
      provide: WagerQueueClient,
      inject: [SQSClient, APP_CONFIG],
      useFactory: (sqs: SQSClient, config: AppConfig) =>
        new WagerQueueClient(sqs, config.sqs.wagerQueueName, config.sqs.wagerDlqName),
    },
    {
      provide: InboxLookup,
      inject: [EntityManager],
      useFactory: (em: EntityManager) => new InboxLookup(em),
    },
    {
      provide: WagerConsumer,
      inject: [WagerQueueClient, InboxLookup, InstrumentedProcessWagerTransaction, PostgresReadinessCheck, ObservabilityMetrics, APP_CONFIG],
      useFactory: (
        queue: WagerQueueClient,
        inbox: InboxLookup,
        process: InstrumentedProcessWagerTransaction,
        database: PostgresReadinessCheck,
        metrics: ObservabilityMetrics,
        config: AppConfig,
      ) => {
        const { name, ...options } = config.sqsConsumer;
        return new WagerConsumer(queue, inbox, process, database, metrics, {
          consumerName: name,
          ...options,
          faultInjection: config.faultInjection,
        });
      },
    },
];

/** Recebe o módulo de persistência já configurado (dinâmico) para a sonda do Postgres. */
@Module({})
export class WagerConsumerModule implements OnApplicationBootstrap, BeforeApplicationShutdown {
  constructor(
    @Inject(WagerConsumer) private readonly consumer: WagerConsumer,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  onApplicationBootstrap(): void {
    if (this.config.sqsConsumer.enabled) this.consumer.start();
  }

  async beforeApplicationShutdown(): Promise<void> {
    await this.consumer.stop();
  }

  static register(persistence: DynamicModule): DynamicModule {
    return {
      module: WagerConsumerModule,
      imports: [persistence, MessagingModule, WageringCoreModule],
      providers,
      exports: [WagerConsumer],
    };
  }
}
