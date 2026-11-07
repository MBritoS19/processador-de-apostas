import { Inject, Module, type BeforeApplicationShutdown, type OnApplicationBootstrap } from '@nestjs/common';
import { SQSClient } from '@aws-sdk/client-sqs';
import { EntityManager } from '@mikro-orm/postgresql';
import { APP_CONFIG, type AppConfig } from '../../infrastructure/config/app-config';
import { MessagingModule } from '../../infrastructure/messaging/messaging.module';
import { ObservabilityMetrics } from '../../infrastructure/observability/metrics';
import { OutboxEventsClient } from '../../infrastructure/outbox/outbox-events.client';
import { OutboxStore } from '../../infrastructure/outbox/outbox-store';
import { systemClock } from '../../infrastructure/system-adapters';
import { OutboxPublisher } from './outbox-publisher';

/**
 * Liga o publisher quando `OUTBOX_PUBLISHER_ENABLED=true`. Para em `beforeApplicationShutdown`,
 * antes de o ORM e o cliente SQS fecharem: o lote em andamento commita dentro do grace period.
 */
@Module({
  imports: [MessagingModule],
  providers: [
    {
      provide: OutboxStore,
      inject: [EntityManager, APP_CONFIG],
      useFactory: (em: EntityManager, config: AppConfig) =>
        new OutboxStore(em, config.outboxPublisher.idleInTransactionTimeoutMs),
    },
    {
      provide: OutboxEventsClient,
      inject: [SQSClient, APP_CONFIG],
      useFactory: (sqs: SQSClient, config: AppConfig) => new OutboxEventsClient(sqs, config.sqs.wagerEventsQueueName),
    },
    {
      provide: OutboxPublisher,
      inject: [OutboxStore, OutboxEventsClient, ObservabilityMetrics, APP_CONFIG],
      useFactory: (store: OutboxStore, events: OutboxEventsClient, metrics: ObservabilityMetrics, config: AppConfig) => {
        const { enabled: _enabled, idleInTransactionTimeoutMs: _idle, ...options } = config.outboxPublisher;
        return new OutboxPublisher(store, events, systemClock, metrics, options);
      },
    },
  ],
  exports: [OutboxPublisher],
})
export class OutboxPublisherModule implements OnApplicationBootstrap, BeforeApplicationShutdown {
  constructor(
    @Inject(OutboxPublisher) private readonly publisher: OutboxPublisher,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  onApplicationBootstrap(): void {
    if (this.config.outboxPublisher.enabled) this.publisher.start();
  }

  async beforeApplicationShutdown(): Promise<void> {
    await this.publisher.stop();
  }
}
