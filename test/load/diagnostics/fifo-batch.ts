/**
 * Quantas mensagens o LocalStack FIFO devolve por ReceiveMessage quando há muitos grupos
 * (diagnóstico do teste de carga, docs/CARGA.md). Cria uma fila FIFO temporária, envia 200
 * mensagens em 200 grupos distintos (como o cenário misto: grupo = walletId), faz 25 receives
 * de até 10 e apaga a fila. Mede o LocalStack OCIOSO.
 *
 *   bun test/load/diagnostics/fifo-batch.ts
 */
import { CreateQueueCommand, DeleteQueueCommand, ReceiveMessageCommand, SendMessageBatchCommand, SQSClient } from '@aws-sdk/client-sqs';

const sqs = new SQSClient({ region: 'us-east-1', endpoint: 'http://localhost:4566', credentials: { accessKeyId: 'test', secretAccessKey: 'test' } });
const { QueueUrl } = await sqs.send(new CreateQueueCommand({ QueueName: `fifo-probe-${Date.now()}.fifo`, Attributes: { FifoQueue: 'true' } }));

for (let batch = 0; batch < 20; batch++) {
  await sqs.send(
    new SendMessageBatchCommand({
      QueueUrl,
      Entries: Array.from({ length: 10 }, (_, i) => ({
        Id: String(i),
        MessageBody: 'x',
        MessageGroupId: `g-${batch * 10 + i}`,
        MessageDeduplicationId: `d-${batch}-${i}`,
      })),
    }),
  );
}

const sizes: number[] = [];
const started = performance.now();
for (let i = 0; i < 25; i++) {
  const { Messages = [] } = await sqs.send(
    new ReceiveMessageCommand({ QueueUrl, MaxNumberOfMessages: 10, WaitTimeSeconds: 0, VisibilityTimeout: 60 }),
  );
  sizes.push(Messages.length);
}
console.log(`mensagens por receive (200 grupos distintos): ${sizes.join(',')} | ${((performance.now() - started) / 25).toFixed(1)} ms/receive`);
await sqs.send(new DeleteQueueCommand({ QueueUrl }));
process.exit(0);
