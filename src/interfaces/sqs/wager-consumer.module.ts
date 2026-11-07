import {
  Inject,
  Module,
  type BeforeApplicationShutdown,
  type OnApplicationBootstrap,
} from '@nestjs/common';
import { SQSClient } from '@aws-sdk/client-sqs';
import { EntityManager } from '@mikro-orm/postgresql';
import { APP_CONFIG, type AppConfig } from '../../infrastructure/config/app-config';
import { MessagingModule } from '../../infrastructure/messaging/messaging.module';
import { InstrumentedProcessWagerTransaction } from '../../infrastructure/observability/instrumented-process-wager-transaction';
import { ObservabilityMetrics } from '../../infrastructure/observability/metrics';
import { InboxLookup } from '../../infrastructure/sqs/inbox-lookup';
import { WagerQueueClient } from '../../infrastructure/sqs/wager-queue.client';
import { WageringCoreModule } from '../../infrastructure/wagering-core.module';
import { WagerConsumer } from './wager-consumer';

/**
 * Liga o consumidor quando `SQS_CONSUMER_ENABLED=true`. Para em `beforeApplicationShutdown`,
 * antes de o ORM e o cliente SQS fecharem (`onApplicationShutdown`).
 */
@Module({
  imports: [MessagingModule, WageringCoreModule],
  providers: [
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
      inject: [WagerQueueClient, InboxLookup, InstrumentedProcessWagerTransaction, ObservabilityMetrics, APP_CONFIG],
      useFactory: (
        queue: WagerQueueClient,
        inbox: InboxLookup,
        process: InstrumentedProcessWagerTransaction,
        metrics: ObservabilityMetrics,
        config: AppConfig,
      ) => {
        const { name, ...options } = config.sqsConsumer;
        return new WagerConsumer(queue, inbox, process, metrics, { consumerName: name, ...options });
      },
    },
  ],
  exports: [WagerConsumer],
})
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
}
