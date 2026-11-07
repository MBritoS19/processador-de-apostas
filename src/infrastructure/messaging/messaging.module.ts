import { Inject, Module, type OnApplicationShutdown } from '@nestjs/common';
import { SQSClient } from '@aws-sdk/client-sqs';
import { APP_CONFIG, type AppConfig } from '../config/app-config';
import { createSqsClient } from './sqs.client';
import { SqsReadinessCheck } from './sqs-readiness.check';

/** Cliente SQS compartilhado (consumidor, outbox publisher) e seu ciclo de vida. */
@Module({
  providers: [
    {
      provide: SQSClient,
      useFactory: (config: AppConfig) => createSqsClient(config),
      inject: [APP_CONFIG],
    },
    SqsReadinessCheck,
  ],
  exports: [SQSClient, SqsReadinessCheck],
})
export class MessagingModule implements OnApplicationShutdown {
  constructor(@Inject(SQSClient) private readonly sqs: SQSClient) {}

  onApplicationShutdown(): void {
    this.sqs.destroy();
  }
}
