import { GetQueueUrlCommand, SendMessageBatchCommand, type SQSClient } from '@aws-sdk/client-sqs';
import type { OutboxMessage } from '../../domain/outbox-message';

/** Resultado por evento: só os ids aceitos pelo broker contam como publicados. */
export interface PublishResult {
  readonly published: ReadonlySet<string>;
  /** eventId → código de erro do SQS (sem mensagem: pode ecoar conteúdo). */
  readonly failed: ReadonlyMap<string, string>;
}

/**
 * Publica eventos da outbox em `wager-events.fifo`. `MessageGroupId` = aggregateId e
 * `MessageDeduplicationId` = eventId (dedup do broker é só otimização: o consumidor
 * deduplica por eventId). O corpo é exatamente o envelope gravado na outbox.
 */
export class OutboxEventsClient {
  private queueUrl: Promise<string> | undefined;

  constructor(
    private readonly sqs: SQSClient,
    private readonly queueName: string,
  ) {}

  /** Lança se a chamada inteira falhar (rede, timeout, fila inexistente). Até 10 mensagens. */
  async publish(messages: readonly OutboxMessage[], signal: AbortSignal): Promise<PublishResult> {
    const QueueUrl = await this.resolve(signal);
    const output = await this.sqs.send(
      new SendMessageBatchCommand({
        QueueUrl,
        Entries: messages.map((message, index) => ({
          Id: String(index),
          MessageBody: JSON.stringify(message.payload),
          MessageGroupId: message.aggregateId,
          MessageDeduplicationId: message.id,
        })),
      }),
      { abortSignal: signal },
    );
    const byIndex = (id: string | undefined) => (id === undefined ? undefined : messages[Number(id)]?.id);
    const published = new Set<string>();
    for (const entry of output.Successful ?? []) {
      const eventId = byIndex(entry.Id);
      if (eventId) published.add(eventId);
    }
    const failed = new Map<string, string>();
    for (const entry of output.Failed ?? []) {
      const eventId = byIndex(entry.Id);
      if (eventId) failed.set(eventId, entry.Code ?? 'unknown');
    }
    // Entrada sem resposta (nem Successful nem Failed): tratada como falha, nunca como publicada.
    for (const message of messages) {
      if (!published.has(message.id) && !failed.has(message.id)) failed.set(message.id, 'missing_result');
    }
    return { published, failed };
  }

  private resolve(signal: AbortSignal): Promise<string> {
    this.queueUrl ??= this.sqs
      .send(new GetQueueUrlCommand({ QueueName: this.queueName }), { abortSignal: signal })
      .then(({ QueueUrl }) => {
        if (!QueueUrl) throw new Error(`fila ${this.queueName} sem URL`);
        return QueueUrl;
      })
      .catch((error: unknown) => {
        this.queueUrl = undefined;
        throw error;
      });
    return this.queueUrl;
  }
}
