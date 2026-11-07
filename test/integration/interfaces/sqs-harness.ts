import 'reflect-metadata';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import {
  CreateQueueCommand,
  DeleteQueueCommand,
  GetQueueAttributesCommand,
  ReceiveMessageCommand,
  SendMessageCommand,
  SQSClient,
} from '@aws-sdk/client-sqs';
import { EntityManager } from '@mikro-orm/postgresql';
import { randomUUID } from 'node:crypto';
import { AppModule } from '../../../src/app.module';
import type { ProcessWagerTransactionCommand, ProcessWagerTransactionResult } from '../../../src/application/wagering/process-wager-transaction';
import { loadConfig, type AppConfig } from '../../../src/infrastructure/config/app-config';
import { InstrumentedProcessWagerTransaction } from '../../../src/infrastructure/observability/instrumented-process-wager-transaction';
import { ObservabilityMetrics } from '../../../src/infrastructure/observability/metrics';
import { WagerQueueClient, type ReceivedMessage } from '../../../src/infrastructure/sqs/wager-queue.client';
import { buildInstrumentedProcess } from '../../../src/infrastructure/wagering-core.module';

export interface TestQueues {
  queueName: string;
  dlqName: string;
  queueUrl: string;
  dlqUrl: string;
}

/** Fila + DLQ próprias do teste (LocalStack real), com a mesma redrive policy da Fase 0. */
export async function createQueues(sqs: SQSClient, maxReceiveCount = 5): Promise<TestQueues> {
  const suffix = randomUUID().slice(0, 8);
  const queueName = `test-wager-${suffix}.fifo`;
  const dlqName = `test-wager-${suffix}-dlq.fifo`;
  const { QueueUrl: dlqUrl } = await sqs.send(
    new CreateQueueCommand({ QueueName: dlqName, Attributes: { FifoQueue: 'true', ContentBasedDeduplication: 'false' } }),
  );
  const { Attributes } = await sqs.send(new GetQueueAttributesCommand({ QueueUrl: dlqUrl, AttributeNames: ['QueueArn'] }));
  const { QueueUrl: queueUrl } = await sqs.send(
    new CreateQueueCommand({
      QueueName: queueName,
      Attributes: {
        FifoQueue: 'true',
        ContentBasedDeduplication: 'false',
        VisibilityTimeout: '30',
        RedrivePolicy: JSON.stringify({ deadLetterTargetArn: Attributes?.QueueArn, maxReceiveCount: String(maxReceiveCount) }),
      },
    }),
  );
  if (!queueUrl || !dlqUrl) throw new Error('fila de teste sem URL');
  return { queueName, dlqName, queueUrl, dlqUrl };
}

export async function deleteQueues(sqs: SQSClient, queues: TestQueues): Promise<void> {
  await Promise.all([queues.queueUrl, queues.dlqUrl].map((QueueUrl) => sqs.send(new DeleteQueueCommand({ QueueUrl }))));
}

export function envelope(
  wallet: { walletId: string; playerId: string },
  overrides: { messageId?: string; data?: Record<string, unknown>; [key: string]: unknown } = {},
): Record<string, unknown> {
  const externalTransactionId = `ext-${randomUUID()}`;
  const { data, ...rest } = overrides;
  return {
    messageId: `msg-${randomUUID()}`,
    type: 'WagerTransactionRequested',
    occurredAt: '2026-11-07T12:00:00.000Z',
    data: {
      providerId: 'provider-a',
      externalTransactionId,
      idempotencyKey: `provider-a:${externalTransactionId}`,
      playerId: wallet.playerId,
      walletId: wallet.walletId,
      roundId: 'round-1',
      gameId: 'game-1',
      kind: 'BET',
      money: { amount: '10.00', currency: 'BRL' },
      ...data,
    },
    ...rest,
  };
}

/** Envia como um produtor faria: grupo = walletId, dedup = messageId (sobrescrevíveis). */
export async function send(
  sqs: SQSClient,
  queueUrl: string,
  body: Record<string, unknown> | string,
  options: { groupId?: string; dedupId?: string } = {},
): Promise<void> {
  const parsed = typeof body === 'string' ? undefined : body;
  const data = parsed?.data as { walletId?: string } | undefined;
  await sqs.send(
    new SendMessageCommand({
      QueueUrl: queueUrl,
      MessageBody: typeof body === 'string' ? body : JSON.stringify(body),
      MessageGroupId: options.groupId ?? data?.walletId ?? 'group-1',
      MessageDeduplicationId: options.dedupId ?? (parsed?.messageId as string | undefined) ?? randomUUID(),
    }),
  );
}

/** Mensagens na fila: visíveis + em voo (+ atrasadas). */
export async function queueDepth(sqs: SQSClient, queueUrl: string): Promise<number> {
  const { Attributes } = await sqs.send(
    new GetQueueAttributesCommand({
      QueueUrl: queueUrl,
      AttributeNames: ['ApproximateNumberOfMessages', 'ApproximateNumberOfMessagesNotVisible', 'ApproximateNumberOfMessagesDelayed'],
    }),
  );
  return (
    Number(Attributes?.ApproximateNumberOfMessages ?? 0) +
    Number(Attributes?.ApproximateNumberOfMessagesNotVisible ?? 0) +
    Number(Attributes?.ApproximateNumberOfMessagesDelayed ?? 0)
  );
}

export async function visibleCount(sqs: SQSClient, queueUrl: string): Promise<number> {
  const { Attributes } = await sqs.send(
    new GetQueueAttributesCommand({ QueueUrl: queueUrl, AttributeNames: ['ApproximateNumberOfMessages'] }),
  );
  return Number(Attributes?.ApproximateNumberOfMessages ?? 0);
}

export interface DeadLetter {
  body: string;
  reason: string | undefined;
  detail: string | undefined;
}

/** Lê (sem apagar) o que está na DLQ. */
export async function readDlq(sqs: SQSClient, dlqUrl: string): Promise<DeadLetter[]> {
  const { Messages } = await sqs.send(
    new ReceiveMessageCommand({
      QueueUrl: dlqUrl,
      MaxNumberOfMessages: 10,
      WaitTimeSeconds: 0,
      VisibilityTimeout: 0,
      MessageAttributeNames: ['All'],
    }),
  );
  return (Messages ?? []).map((message) => ({
    body: message.Body ?? '',
    reason: message.MessageAttributes?.dlqReason?.StringValue,
    detail: message.MessageAttributes?.dlqDetail?.StringValue,
  }));
}

/** Repete `check` até passar ou estourar o prazo (o último erro é relançado). */
export async function eventually(check: () => Promise<void> | void, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      await check();
      return;
    } catch (error) {
      if (Date.now() > deadline) throw error;
      await Bun.sleep(100);
    }
  }
}

type Process = Pick<InstrumentedProcessWagerTransaction, 'execute'>;

export interface ConsumerAppOptions {
  queues: TestQueues;
  consumer?: Partial<AppConfig['sqsConsumer']>;
  /** Embrulha o use case real (instrumentado) — só para injetar falha/atraso no teste. */
  wrapProcess?: (real: Process) => Process;
  /** Substitui o cliente da fila — só para injetar falha no teste. */
  queueClient?: (sqs: SQSClient, config: AppConfig) => WagerQueueClient;
}

/** Sobe a aplicação inteira (Nest) com o consumidor ligado, apontando para as filas do teste. */
export async function startConsumerApp(options: ConsumerAppOptions): Promise<INestApplication> {
  const base = loadConfig();
  const config: AppConfig = {
    ...base,
    sqs: { wagerQueueName: options.queues.queueName, wagerDlqName: options.queues.dlqName },
    sqsConsumer: {
      ...base.sqsConsumer,
      enabled: true,
      name: 'wager-consumer-test',
      waitTimeSeconds: 1,
      visibilityTimeoutSeconds: 10,
      retryBaseSeconds: 0,
      retryMaxSeconds: 0,
      shutdownTimeoutMs: 5_000,
      ...options.consumer,
    },
  };
  let builder = Test.createTestingModule({ imports: [AppModule.register(config)] });
  if (options.wrapProcess) {
    const wrap = options.wrapProcess;
    builder = builder.overrideProvider(InstrumentedProcessWagerTransaction).useFactory({
      inject: [EntityManager, ObservabilityMetrics],
      factory: (em: EntityManager, metrics: ObservabilityMetrics) => wrap(buildInstrumentedProcess(em, metrics)),
    });
  }
  if (options.queueClient) {
    const create = options.queueClient;
    builder = builder.overrideProvider(WagerQueueClient).useFactory({
      inject: [SQSClient],
      factory: (sqs: SQSClient) => create(sqs, config),
    });
  }
  const moduleRef = await builder.compile();
  const app = moduleRef.createNestApplication({ logger: false });
  await app.init();
  return app;
}

/** Use case que falha (TransientFailure ou exceção) nas primeiras `failures` chamadas. */
export function failing(
  failures: number,
  mode: 'transient' | 'throw' = 'transient',
): { wrap: (real: Process) => Process; calls: () => number } {
  let calls = 0;
  return {
    calls: () => calls,
    wrap: (real) => ({
      async execute(command: ProcessWagerTransactionCommand): Promise<ProcessWagerTransactionResult> {
        calls++;
        if (calls <= failures) {
          if (mode === 'throw') throw new Error('falha injetada');
          return { type: 'TransientFailure', reason: 'lock_timeout' };
        }
        return real.execute(command);
      },
    }),
  };
}

/** Use case que espera `gate` antes de processar; `started` resolve quando a 1ª chamada chega. */
export function gated(): {
  wrap: (real: Process) => Process;
  started: Promise<void>;
  open: () => void;
  abort: () => void;
  calls: () => number;
} {
  let calls = 0;
  let markStarted!: () => void;
  const started = new Promise<void>((resolve) => (markStarted = resolve));
  let release!: (proceed: boolean) => void;
  const gate = new Promise<boolean>((resolve) => (release = resolve));
  return {
    started,
    open: () => release(true),
    abort: () => release(false),
    calls: () => calls,
    wrap: (real) => ({
      async execute(command: ProcessWagerTransactionCommand): Promise<ProcessWagerTransactionResult> {
        calls++;
        markStarted();
        if (!(await gate)) throw new Error('processamento abortado pelo teste');
        return real.execute(command);
      },
    }),
  };
}

/** Cliente cujo DeleteMessage falha nas primeiras `failures` chamadas (worker morto antes do ack). */
export class FailingDeleteQueueClient extends WagerQueueClient {
  deletes = 0;

  constructor(
    sqs: SQSClient,
    config: AppConfig,
    private readonly failures: number,
  ) {
    super(sqs, config.sqs.wagerQueueName, config.sqs.wagerDlqName);
  }

  override async delete(message: ReceivedMessage): Promise<void> {
    this.deletes++;
    if (this.deletes <= this.failures) throw new Error('DeleteMessage falhou (injetado)');
    return super.delete(message);
  }
}
