import {
  Inject,
  Module,
  type BeforeApplicationShutdown,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
} from '@nestjs/common';
import type { SQSClient } from '@aws-sdk/client-sqs';
import { EntityManager } from '@mikro-orm/postgresql';
import { APP_CONFIG, type AppConfig } from '../../infrastructure/config/app-config';
import { createSqsClient } from '../../infrastructure/messaging/sqs.client';
import { ObservabilityMetrics } from '../../infrastructure/observability/metrics';
import { OutboxEventsClient } from '../../infrastructure/outbox/outbox-events.client';
import { OutboxStore } from '../../infrastructure/outbox/outbox-store';
import { systemClock } from '../../infrastructure/system-adapters';
import { OutboxPublisher } from './outbox-publisher';

/**
 * Cliente SQS só do publisher, com `maxAttempts: 1`: o `abortSignal` não interrompe a espera entre
 * retries do SDK, e o retry do publisher (backoff gravado na outbox) já cobre a falha.
 */
const OUTBOX_SQS_CLIENT = Symbol('OUTBOX_SQS_CLIENT');

/**
 * Liga o publisher quando `OUTBOX_PUBLISHER_ENABLED=true`. Para em `beforeApplicationShutdown`,
 * antes de o ORM e o cliente SQS fecharem: o lote em andamento commita dentro do grace period.
 */
@Module({
  providers: [
    {
      provide: OUTBOX_SQS_CLIENT,
      inject: [APP_CONFIG],
      useFactory: (config: AppConfig) => createSqsClient(config, { maxAttempts: 1 }),
    },
    {
      provide: OutboxStore,
      inject: [EntityManager, APP_CONFIG],
      useFactory: (em: EntityManager, config: AppConfig) =>
        new OutboxStore(em, config.outboxPublisher.idleInTransactionTimeoutMs),
    },
    {
      provide: OutboxEventsClient,
      inject: [OUTBOX_SQS_CLIENT, APP_CONFIG],
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
export class OutboxPublisherModule implements OnApplicationBootstrap, BeforeApplicationShutdown, OnApplicationShutdown {
  constructor(
    @Inject(OutboxPublisher) private readonly publisher: OutboxPublisher,
    @Inject(OUTBOX_SQS_CLIENT) private readonly sqs: SQSClient,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  onApplicationBootstrap(): void {
    if (this.config.outboxPublisher.enabled) this.publisher.start();
  }

  async beforeApplicationShutdown(): Promise<void> {
    await this.publisher.stop();
  }

  onApplicationShutdown(): void {
    this.sqs.destroy();
  }
}
