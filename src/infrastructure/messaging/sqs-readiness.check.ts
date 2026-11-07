import { Inject, Injectable } from '@nestjs/common';
import { GetQueueUrlCommand, SQSClient } from '@aws-sdk/client-sqs';
import { DependencyUnreachableError, type ReadinessCheck } from '../../application/ports/readiness-check';
import { APP_CONFIG, type AppConfig } from '../config/app-config';
import { isNetworkError } from '../network-errors';

/** Pronto quando a fila principal e a DLQ existem e respondem. */
@Injectable()
export class SqsReadinessCheck implements ReadinessCheck {
  readonly name = 'sqs';

  constructor(
    private readonly sqs: SQSClient,
    @Inject(APP_CONFIG) private readonly config: Pick<AppConfig, 'sqs'>,
  ) {}

  async check(signal: AbortSignal): Promise<void> {
    const { wagerQueueName, wagerDlqName } = this.config.sqs;
    try {
      await Promise.all(
        [wagerQueueName, wagerDlqName].map((QueueName) =>
          this.sqs.send(new GetQueueUrlCommand({ QueueName }), { abortSignal: signal }),
        ),
      );
    } catch (error: unknown) {
      if (isNetworkError(error)) throw new DependencyUnreachableError(this.name, { cause: error });
      throw error;
    }
  }
}
