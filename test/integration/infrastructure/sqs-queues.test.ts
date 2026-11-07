import { afterAll, describe, expect, it } from 'bun:test';
import { GetQueueAttributesCommand, GetQueueUrlCommand } from '@aws-sdk/client-sqs';
import { loadConfig } from '../../../src/infrastructure/config/app-config';
import { createSqsClient } from '../../../src/infrastructure/messaging/sqs.client';

/** LocalStack real (docker compose): filas criadas pelo init script. */
describe('filas SQS', () => {
  const config = loadConfig();
  const sqs = createSqsClient(config);

  afterAll(() => sqs.destroy());

  const attributesOf = async (QueueName: string) => {
    const { QueueUrl } = await sqs.send(new GetQueueUrlCommand({ QueueName }));
    const { Attributes } = await sqs.send(
      new GetQueueAttributesCommand({ QueueUrl, AttributeNames: ['All'] }),
    );
    if (!Attributes) throw new Error(`fila ${QueueName} sem atributos`);
    return Attributes;
  };

  it('a DLQ existe e é FIFO', async () => {
    const dlq = await attributesOf(config.sqs.wagerDlqName);
    expect(dlq.FifoQueue).toBe('true');
    expect(dlq.ContentBasedDeduplication).toBe('false');
  });

  it('a fila principal é FIFO, sem dedup por conteúdo, e redireciona para a DLQ', async () => {
    const dlq = await attributesOf(config.sqs.wagerDlqName);
    const main = await attributesOf(config.sqs.wagerQueueName);

    expect(main.FifoQueue).toBe('true');
    expect(main.ContentBasedDeduplication).toBe('false');

    const redrive = JSON.parse(main.RedrivePolicy ?? '{}') as {
      deadLetterTargetArn?: string;
      maxReceiveCount?: string | number;
    };
    expect(redrive.deadLetterTargetArn).toBe(dlq.QueueArn);
    expect(Number(redrive.maxReceiveCount)).toBe(10);
  });
});
