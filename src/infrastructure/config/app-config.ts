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
    healthCheckTimeoutMs: positiveInt('HEALTH_CHECK_TIMEOUT_MS', 2000, 60_000),
  };

  if (problems.length > 0) throw new InvalidConfigError(problems);
  return config;
}

/** Token de injeção do NestJS para a config. */
export const APP_CONFIG = Symbol('APP_CONFIG');
