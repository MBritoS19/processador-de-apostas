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
  readonly healthCheckTimeoutMs: number;
}

export class InvalidConfigError extends Error {
  constructor(readonly problems: readonly string[]) {
    super(`Configuração inválida:\n- ${problems.join('\n- ')}`);
    this.name = 'InvalidConfigError';
  }
}

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
    healthCheckTimeoutMs: positiveInt('HEALTH_CHECK_TIMEOUT_MS', 2000, 60_000),
  };
  if (config.sqsConsumer.name.length > 256) problems.push('SQS_CONSUMER_NAME excede 256 caracteres');
  if (config.sqsConsumer.retryMaxSeconds < config.sqsConsumer.retryBaseSeconds) {
    problems.push('SQS_RETRY_MAX_SECONDS deve ser maior ou igual a SQS_RETRY_BASE_SECONDS');
  }

  if (problems.length > 0) throw new InvalidConfigError(problems);
  return config;
}

/** Token de injeção do NestJS para a config. */
export const APP_CONFIG = Symbol('APP_CONFIG');
