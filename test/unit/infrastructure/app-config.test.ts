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
