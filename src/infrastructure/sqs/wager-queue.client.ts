import {
  ChangeMessageVisibilityCommand,
  DeleteMessageCommand,
  GetQueueAttributesCommand,
  GetQueueUrlCommand,
  ReceiveMessageCommand,
  SendMessageCommand,
  type SQSClient,
} from '@aws-sdk/client-sqs';

/** Mensagem recebida, só com o que o consumidor usa. */
export interface ReceivedMessage {
  /** MessageId do SQS (não o do envelope). */
  readonly sqsMessageId: string;
  readonly receiptHandle: string;
  readonly body: string;
  readonly groupId: string | undefined;
  readonly receiveCount: number;
}

export interface ReceiveOptions {
  maxMessages: number;
  waitTimeSeconds: number;
  visibilityTimeoutSeconds: number;
  /** Aborta o long polling (shutdown): o consumidor não espera até `waitTimeSeconds` para parar. */
  signal?: AbortSignal;
}

/** Motivos estáveis de envio para a DLQ (atributo `dlqReason`). */
export type DlqReason =
  | 'INVALID_ENVELOPE'
  | 'INVALID_PAYLOAD'
  | 'INBOX_PAYLOAD_MISMATCH'
  | 'MAX_ATTEMPTS_EXCEEDED'
  /** O diário de partidas dobradas recusou o lançamento: bug, sem retry. */
  | 'JOURNAL_INTEGRITY_VIOLATION';

const MAX_ATTRIBUTE_LENGTH = 256;

/**
 * Operações da fila de transações e da sua DLQ. As URLs e o `maxReceiveCount` (da
 * `RedrivePolicy`, a fonte de verdade do limite) são lidos uma vez, no primeiro uso.
 */
export class WagerQueueClient {
  private resolved: Promise<{ queueUrl: string; dlqUrl: string; maxReceiveCount: number }> | undefined;

  constructor(
    private readonly sqs: SQSClient,
    private readonly queueName: string,
    private readonly dlqName: string,
  ) {}

  async maxReceiveCount(): Promise<number> {
    return (await this.resolve()).maxReceiveCount;
  }

  async receive(options: ReceiveOptions): Promise<ReceivedMessage[]> {
    const { queueUrl } = await this.resolve();
    const output = await this.sqs.send(
      new ReceiveMessageCommand({
        QueueUrl: queueUrl,
        MaxNumberOfMessages: options.maxMessages,
        WaitTimeSeconds: options.waitTimeSeconds,
        VisibilityTimeout: options.visibilityTimeoutSeconds,
        MessageSystemAttributeNames: ['ApproximateReceiveCount', 'MessageGroupId'],
      }),
      options.signal ? { abortSignal: options.signal } : {},
    );
    return (output.Messages ?? []).flatMap((message) => {
      if (!message.MessageId || !message.ReceiptHandle) return [];
      return [
        {
          sqsMessageId: message.MessageId,
          receiptHandle: message.ReceiptHandle,
          body: message.Body ?? '',
          groupId: message.Attributes?.MessageGroupId,
          receiveCount: Number(message.Attributes?.ApproximateReceiveCount ?? '1'),
        },
      ];
    });
  }

  async delete(message: ReceivedMessage): Promise<void> {
    const { queueUrl } = await this.resolve();
    await this.sqs.send(new DeleteMessageCommand({ QueueUrl: queueUrl, ReceiptHandle: message.receiptHandle }));
  }

  async changeVisibility(message: ReceivedMessage, seconds: number): Promise<void> {
    const { queueUrl } = await this.resolve();
    await this.sqs.send(
      new ChangeMessageVisibilityCommand({
        QueueUrl: queueUrl,
        ReceiptHandle: message.receiptHandle,
        VisibilityTimeout: seconds,
      }),
    );
  }

  /**
   * Copia a mensagem para a DLQ com o motivo nos atributos. Não apaga da fila principal:
   * o chamador apaga só depois do envio. Dedup pelo MessageId do SQS: reenviar a mesma
   * mensagem (DeleteMessage falhou) não duplica na DLQ dentro da janela de 5 min.
   */
  async sendToDlq(message: ReceivedMessage, reason: DlqReason, detail: string): Promise<void> {
    const { dlqUrl } = await this.resolve();
    await this.sqs.send(
      new SendMessageCommand({
        QueueUrl: dlqUrl,
        MessageBody: message.body === '' ? '(vazio)' : message.body,
        MessageGroupId: message.groupId ?? 'no-group',
        MessageDeduplicationId: message.sqsMessageId,
        MessageAttributes: {
          dlqReason: { DataType: 'String', StringValue: reason },
          dlqDetail: { DataType: 'String', StringValue: detail.slice(0, MAX_ATTRIBUTE_LENGTH) || '-' },
          sourceMessageId: { DataType: 'String', StringValue: message.sqsMessageId },
          receiveCount: { DataType: 'Number', StringValue: String(message.receiveCount) },
        },
      }),
    );
  }

  private resolve(): Promise<{ queueUrl: string; dlqUrl: string; maxReceiveCount: number }> {
    this.resolved ??= this.load().catch((error: unknown) => {
      this.resolved = undefined;
      throw error;
    });
    return this.resolved;
  }

  private async load(): Promise<{ queueUrl: string; dlqUrl: string; maxReceiveCount: number }> {
    const [queue, dlq] = await Promise.all(
      [this.queueName, this.dlqName].map((QueueName) => this.sqs.send(new GetQueueUrlCommand({ QueueName }))),
    );
    const queueUrl = queue?.QueueUrl;
    const dlqUrl = dlq?.QueueUrl;
    if (!queueUrl || !dlqUrl) throw new Error('URL da fila ou da DLQ não retornada');
    const { Attributes } = await this.sqs.send(
      new GetQueueAttributesCommand({ QueueUrl: queueUrl, AttributeNames: ['RedrivePolicy'] }),
    );
    const policy = JSON.parse(Attributes?.RedrivePolicy ?? '{}') as { maxReceiveCount?: string | number };
    const maxReceiveCount = Number(policy.maxReceiveCount);
    if (!Number.isInteger(maxReceiveCount) || maxReceiveCount < 1) {
      throw new Error(`fila ${this.queueName} sem RedrivePolicy válida`);
    }
    return { queueUrl, dlqUrl, maxReceiveCount };
  }
}
