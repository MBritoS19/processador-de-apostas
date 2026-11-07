import { describe, expect, it } from 'bun:test';
import { InvalidConfigError, loadConfig } from '../../../src/infrastructure/config/app-config';

const validEnv = {
  DATABASE_URL: 'postgres://u:p@localhost:5432/db',
  AWS_ENDPOINT_URL: 'http://localhost:4566',
};

function problemsOf(env: Record<string, string | undefined>): readonly string[] {
  try {
    loadConfig(env);
  } catch (error) {
    if (error instanceof InvalidConfigError) return error.problems;
    throw error;
  }
  throw new Error('esperava InvalidConfigError');
}

describe('loadConfig', () => {
  it('aplica defaults quando só o obrigatório é informado', () => {
    const config = loadConfig({ DATABASE_URL: validEnv.DATABASE_URL });

    expect(config.httpPort).toBe(3000);
    expect(config.aws.region).toBe('us-east-1');
    expect(config.aws.endpointUrl).toBeUndefined();
    expect(config.sqs.wagerQueueName).toBe('wager-transactions.fifo');
    expect(config.sqs.wagerDlqName).toBe('wager-transactions-dlq.fifo');
    expect(config.healthCheckTimeoutMs).toBe(2000);
  });

  it('lê os valores informados', () => {
    const config = loadConfig({
      ...validEnv,
      HTTP_PORT: '8080',
      SQS_WAGER_QUEUE_NAME: 'outra.fifo',
      HEALTH_CHECK_TIMEOUT_MS: '500',
    });

    expect(config.httpPort).toBe(8080);
    expect(config.aws.endpointUrl).toBe('http://localhost:4566');
    expect(config.sqs.wagerQueueName).toBe('outra.fifo');
    expect(config.healthCheckTimeoutMs).toBe(500);
  });

  it('consumidor SQS: defaults e valores informados', () => {
    expect(loadConfig({ DATABASE_URL: validEnv.DATABASE_URL }).sqsConsumer).toEqual({
      enabled: true,
      name: 'wager-transactions-consumer',
      maxMessages: 10,
      waitTimeSeconds: 20,
      visibilityTimeoutSeconds: 60,
      retryBaseSeconds: 30,
      retryMaxSeconds: 300,
      shutdownTimeoutMs: 25_000,
    });
    const config = loadConfig({
      ...validEnv,
      SQS_CONSUMER_ENABLED: 'false',
      SQS_WAIT_TIME_SECONDS: '0',
      SQS_RETRY_BASE_SECONDS: '0',
      SQS_SHUTDOWN_TIMEOUT_MS: '100',
    });
    expect(config.sqsConsumer.enabled).toBe(false);
    expect(config.sqsConsumer.waitTimeSeconds).toBe(0);
    expect(config.sqsConsumer.retryBaseSeconds).toBe(0);
    expect(config.sqsConsumer.shutdownTimeoutMs).toBe(100);
  });

  it('consumidor SQS: rejeita valores fora da faixa', () => {
    expect(problemsOf({ ...validEnv, SQS_CONSUMER_ENABLED: 'sim' })).toEqual([
      'SQS_CONSUMER_ENABLED deve ser "true" ou "false" (recebido: "sim")',
    ]);
    expect(problemsOf({ ...validEnv, SQS_MAX_MESSAGES: '11' })).toEqual([
      'SQS_MAX_MESSAGES deve ser um inteiro entre 1 e 10 (recebido: "11")',
    ]);
    expect(problemsOf({ ...validEnv, SQS_WAIT_TIME_SECONDS: '21' })).toEqual([
      'SQS_WAIT_TIME_SECONDS deve ser um inteiro entre 0 e 20 (recebido: "21")',
    ]);
    expect(problemsOf({ ...validEnv, SQS_RETRY_BASE_SECONDS: '60', SQS_RETRY_MAX_SECONDS: '30' })).toEqual([
      'SQS_RETRY_MAX_SECONDS deve ser maior ou igual a SQS_RETRY_BASE_SECONDS',
    ]);
  });

  it('exige DATABASE_URL', () => {
    expect(problemsOf({})).toContain('DATABASE_URL é obrigatória');
    expect(problemsOf({ DATABASE_URL: '   ' })).toContain('DATABASE_URL é obrigatória');
  });

  it('rejeita DATABASE_URL que não é postgres', () => {
    expect(problemsOf({ DATABASE_URL: 'mysql://localhost/db' })).toEqual([
      'DATABASE_URL deve usar postgres: ou postgresql:',
    ]);
    expect(problemsOf({ DATABASE_URL: 'não é url' })).toEqual(['DATABASE_URL não é uma URL válida']);
  });

  it.each(['abc', '0', '-1', '1.5', '70000', '1e3'])('rejeita HTTP_PORT inválida: %p', (port) => {
    expect(problemsOf({ ...validEnv, HTTP_PORT: port })[0]).toStartWith('HTTP_PORT deve ser um inteiro');
  });

  it('exige filas FIFO', () => {
    expect(problemsOf({ ...validEnv, SQS_WAGER_DLQ_NAME: 'dlq-padrao' })).toEqual([
      'SQS_WAGER_DLQ_NAME deve terminar em ".fifo"',
    ]);
  });

  it('exige as duas credenciais AWS juntas', () => {
    const message = 'AWS_ACCESS_KEY_ID e AWS_SECRET_ACCESS_KEY devem ser informadas juntas';
    expect(problemsOf({ ...validEnv, AWS_ACCESS_KEY_ID: 'test' })).toEqual([message]);
    expect(problemsOf({ ...validEnv, AWS_SECRET_ACCESS_KEY: 'test' })).toEqual([message]);
    expect(loadConfig({ ...validEnv, AWS_ACCESS_KEY_ID: 'a', AWS_SECRET_ACCESS_KEY: 'b' }).aws.accessKeyId).toBe('a');
  });

  it('reporta todos os problemas de uma vez', () => {
    expect(problemsOf({ HTTP_PORT: 'x', AWS_ENDPOINT_URL: 'ftp://x' })).toHaveLength(3);
  });
});
