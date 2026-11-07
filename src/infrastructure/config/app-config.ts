/**
 * Configuração da aplicação, lida de variáveis de ambiente e validada no boot.
 * Qualquer variável ausente ou inválida derruba o processo antes de aceitar tráfego.
 */
export interface AppConfig {
  readonly nodeEnv: string;
  readonly httpPort: number;
  readonly databaseUrl: string;
  readonly aws: {
    readonly region: string;
    readonly endpointUrl: string | undefined;
    readonly accessKeyId: string | undefined;
    readonly secretAccessKey: string | undefined;
  };
  readonly sqs: {
    readonly wagerQueueName: string;
    readonly wagerDlqName: string;
    /** Destino do outbox publisher (Fase 6). FIFO, sem DLQ. */
    readonly wagerEventsQueueName: string;
  };
  /** Outbox publisher (Fase 6). Números justificados no ARCHITECTURE.md §19. */
  readonly outboxPublisher: {
    readonly enabled: boolean;
    /** Até 10: limite do SendMessageBatch. */
    readonly batchSize: number;
    /** Espera só quando o claim volta vazio. */
    readonly pollIntervalMs: number;
    /** Timeout do SendMessageBatch (sem retries do SDK); `+ 2s` ≤ `idleInTransactionTimeoutMs`. */
    readonly sqsTimeoutMs: number;
    /** `idle_in_transaction_session_timeout` da transação do claim (o lock é segurado durante o envio). */
    readonly idleInTransactionTimeoutMs: number;
    /** A partir de quantas tentativas o evento é considerado travado (log error + gauge). */
    readonly stuckAttempts: number;
    readonly shutdownTimeoutMs: number;
  };
  /** Consumidor da fila de transações (Fase 5). Números justificados no ARCHITECTURE.md §18. */
  readonly sqsConsumer: {
    readonly enabled: boolean;
    /** Chave da inbox: `(consumerName, messageId)`. */
    readonly name: string;
    readonly maxMessages: number;
    readonly waitTimeSeconds: number;
    readonly visibilityTimeoutSeconds: number;
    readonly retryBaseSeconds: number;
    readonly retryMaxSeconds: number;
    /** Limite do consumidor (DLQ com motivo); o `maxReceiveCount` da fila fica acima, como rede de segurança. */
    readonly maxAttempts: number;
    readonly shutdownTimeoutMs: number;
  };
  /** Worker de referências pendentes (Fase 7). Números justificados no ARCHITECTURE.md §20. */
  readonly pendingReferences: {
    readonly workerEnabled: boolean;
    readonly batchSize: number;
    /** Espera só quando a busca de candidatas volta vazia ou nenhuma avançou. */
    readonly pollIntervalMs: number;
    /** Intervalo de atualização do gauge de pendentes. */
    readonly gaugeIntervalMs: number;
    /** Prazo da referência a partir do createdAt (vale também para o use case). */
    readonly ttlMs: number;
    readonly shutdownTimeoutMs: number;
  };
  readonly healthCheckTimeoutMs: number;
}

export class InvalidConfigError extends Error {
  constructor(readonly problems: readonly string[]) {
    super(`Configuração inválida:\n- ${problems.join('\n- ')}`);
    this.name = 'InvalidConfigError';
  }
}

/** Folga mínima entre o timeout do SQS e o idle timeout da transação do claim. */
export const OUTBOX_TIMEOUT_MARGIN_MS = 2_000;

type Env = Readonly<Record<string, string | undefined>>;

export function loadConfig(env: Env = process.env): AppConfig {
  const problems: string[] = [];

  const required = (name: string): string => {
    const value = env[name]?.trim();
    if (!value) {
      problems.push(`${name} é obrigatória`);
      return '';
    }
    return value;
  };

  const optional = (name: string): string | undefined => env[name]?.trim() || undefined;

  const positiveInt = (name: string, fallback: number, max = Number.MAX_SAFE_INTEGER): number => {
    const raw = env[name]?.trim();
    if (raw === undefined || raw === '') return fallback;
    const value = Number(raw);
    if (!/^\d+$/.test(raw) || value <= 0 || value > max) {
      problems.push(`${name} deve ser um inteiro entre 1 e ${max} (recebido: "${raw}")`);
      return fallback;
    }
    return value;
  };

  const intInRange = (name: string, fallback: number, min: number, max: number): number => {
    const raw = env[name]?.trim();
    if (raw === undefined || raw === '') return fallback;
    const value = Number(raw);
    if (!/^\d+$/.test(raw) || value < min || value > max) {
      problems.push(`${name} deve ser um inteiro entre ${min} e ${max} (recebido: "${raw}")`);
      return fallback;
    }
    return value;
  };

  const bool = (name: string, fallback: boolean): boolean => {
    const raw = env[name]?.trim();
    if (raw === undefined || raw === '') return fallback;
    if (raw !== 'true' && raw !== 'false') {
      problems.push(`${name} deve ser "true" ou "false" (recebido: "${raw}")`);
      return fallback;
    }
    return raw === 'true';
  };

  const url = (name: string, value: string | undefined, protocols: readonly string[]): void => {
    if (!value) return;
    try {
      const parsed = new URL(value);
      if (!protocols.includes(parsed.protocol)) {
        problems.push(`${name} deve usar ${protocols.join(' ou ')}`);
      }
    } catch {
      problems.push(`${name} não é uma URL válida`);
    }
  };

  const fifoQueue = (name: string, fallback: string): string => {
    const value = optional(name) ?? fallback;
    if (!value.endsWith('.fifo')) problems.push(`${name} deve terminar em ".fifo"`);
    return value;
  };

  const databaseUrl = required('DATABASE_URL');
  url('DATABASE_URL', databaseUrl, ['postgres:', 'postgresql:']);

  const endpointUrl = optional('AWS_ENDPOINT_URL');
  url('AWS_ENDPOINT_URL', endpointUrl, ['http:', 'https:']);

  const accessKeyId = optional('AWS_ACCESS_KEY_ID');
  const secretAccessKey = optional('AWS_SECRET_ACCESS_KEY');
  if ((accessKeyId === undefined) !== (secretAccessKey === undefined)) {
    // Só uma das duas: o SDK cairia silenciosamente na cadeia padrão de credenciais.
    problems.push('AWS_ACCESS_KEY_ID e AWS_SECRET_ACCESS_KEY devem ser informadas juntas');
  }

  const config: AppConfig = {
    nodeEnv: optional('NODE_ENV') ?? 'development',
    httpPort: positiveInt('HTTP_PORT', 3000, 65535),
    databaseUrl,
    aws: {
      region: optional('AWS_REGION') ?? 'us-east-1',
      endpointUrl,
      accessKeyId,
      secretAccessKey,
    },
    sqs: {
      wagerQueueName: fifoQueue('SQS_WAGER_QUEUE_NAME', 'wager-transactions.fifo'),
      wagerDlqName: fifoQueue('SQS_WAGER_DLQ_NAME', 'wager-transactions-dlq.fifo'),
      wagerEventsQueueName: fifoQueue('SQS_WAGER_EVENTS_QUEUE_NAME', 'wager-events.fifo'),
    },
    outboxPublisher: {
      enabled: bool('OUTBOX_PUBLISHER_ENABLED', true),
      batchSize: intInRange('OUTBOX_BATCH_SIZE', 10, 1, 10),
      pollIntervalMs: intInRange('OUTBOX_POLL_INTERVAL_MS', 500, 1, 60_000),
      sqsTimeoutMs: intInRange('OUTBOX_SQS_TIMEOUT_MS', 3_000, 100, 60_000),
      idleInTransactionTimeoutMs: intInRange('OUTBOX_IDLE_IN_TRANSACTION_TIMEOUT_MS', 15_000, 1_000, 300_000),
      stuckAttempts: intInRange('OUTBOX_STUCK_ATTEMPTS', 10, 1, 1000),
      shutdownTimeoutMs: intInRange('OUTBOX_SHUTDOWN_TIMEOUT_MS', 25_000, 0, 600_000),
    },
    sqsConsumer: {
      enabled: bool('SQS_CONSUMER_ENABLED', true),
      name: optional('SQS_CONSUMER_NAME') ?? 'wager-transactions-consumer',
      maxMessages: intInRange('SQS_MAX_MESSAGES', 10, 1, 10),
      waitTimeSeconds: intInRange('SQS_WAIT_TIME_SECONDS', 20, 0, 20),
      visibilityTimeoutSeconds: intInRange('SQS_VISIBILITY_TIMEOUT_SECONDS', 60, 1, 43_200),
      retryBaseSeconds: intInRange('SQS_RETRY_BASE_SECONDS', 30, 0, 43_200),
      retryMaxSeconds: intInRange('SQS_RETRY_MAX_SECONDS', 300, 0, 43_200),
      maxAttempts: intInRange('SQS_CONSUMER_MAX_ATTEMPTS', 5, 1, 1000),
      shutdownTimeoutMs: intInRange('SQS_SHUTDOWN_TIMEOUT_MS', 25_000, 0, 600_000),
    },
    pendingReferences: {
      workerEnabled: bool('PENDING_REFERENCE_WORKER_ENABLED', true),
      batchSize: intInRange('PENDING_REFERENCE_BATCH_SIZE', 10, 1, 100),
      pollIntervalMs: intInRange('PENDING_REFERENCE_POLL_INTERVAL_MS', 1_000, 1, 60_000),
      gaugeIntervalMs: intInRange('PENDING_REFERENCE_GAUGE_INTERVAL_MS', 10_000, 1, 600_000),
      ttlMs: intInRange('PENDING_REFERENCE_TTL_MS', 3_600_000, 1_000, 7 * 24 * 3_600_000),
      shutdownTimeoutMs: intInRange('PENDING_REFERENCE_SHUTDOWN_TIMEOUT_MS', 25_000, 0, 600_000),
    },
    healthCheckTimeoutMs: positiveInt('HEALTH_CHECK_TIMEOUT_MS', 2000, 60_000),
  };
  if (config.sqsConsumer.name.length > 256) problems.push('SQS_CONSUMER_NAME excede 256 caracteres');
  if (config.sqsConsumer.retryMaxSeconds < config.sqsConsumer.retryBaseSeconds) {
    problems.push('SQS_RETRY_MAX_SECONDS deve ser maior ou igual a SQS_RETRY_BASE_SECONDS');
  }

  if (config.outboxPublisher.sqsTimeoutMs + OUTBOX_TIMEOUT_MARGIN_MS > config.outboxPublisher.idleInTransactionTimeoutMs) {
    // O lock do claim é segurado durante o envio: um SQS lento não pode segurá-lo além do timeout da
    // transação. A folga cobre o save e o commit depois do envio.
    problems.push(
      `OUTBOX_SQS_TIMEOUT_MS + ${OUTBOX_TIMEOUT_MARGIN_MS} deve ser menor ou igual a OUTBOX_IDLE_IN_TRANSACTION_TIMEOUT_MS`,
    );
  }

  if (problems.length > 0) throw new InvalidConfigError(problems);
  return config;
}

/** Token de injeção do NestJS para a config. */
export const APP_CONFIG = Symbol('APP_CONFIG');
