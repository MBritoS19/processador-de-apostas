import { afterAll, describe, expect, it } from 'bun:test';
import { MikroORM } from '@mikro-orm/postgresql';
import { DependencyUnreachableError } from '../../../src/application/ports/readiness-check';
import { loadConfig } from '../../../src/infrastructure/config/app-config';
import { createSqsClient } from '../../../src/infrastructure/messaging/sqs.client';
import { SqsReadinessCheck } from '../../../src/infrastructure/messaging/sqs-readiness.check';
import { buildMikroOrmConfig } from '../../../src/infrastructure/persistence/mikro-orm.config';
import { PostgresReadinessCheck } from '../../../src/infrastructure/persistence/postgres-readiness.check';

/** Adaptadores contra Postgres/LocalStack reais, e contra uma porta fechada (dependência fora). */
const config = loadConfig();
const CLOSED = 'http://127.0.0.1:1';
const signal = () => new AbortController().signal;
const toClose: Array<() => Promise<unknown> | unknown> = [];

afterAll(async () => {
  for (const close of toClose) await close();
});

async function orm(databaseUrl: string): Promise<MikroORM> {
  const instance = await MikroORM.init({ ...buildMikroOrmConfig({ databaseUrl }), connect: false });
  toClose.push(() => instance.close(true));
  return instance;
}

describe('PostgresReadinessCheck', () => {
  it('passa com o Postgres de pé', async () => {
    const check = new PostgresReadinessCheck(await orm(config.databaseUrl), config);
    await expect(check.check(signal())).resolves.toBeUndefined();
  });

  it('banco inalcançável → DependencyUnreachableError', async () => {
    const check = new PostgresReadinessCheck(
      await orm('postgres://wagering:wagering@127.0.0.1:1/wagering_test'),
      config,
    );
    await expect(check.check(signal())).rejects.toBeInstanceOf(DependencyUnreachableError);
  });

  it('respeita signal já abortado sem tocar no banco', async () => {
    const check = new PostgresReadinessCheck(await orm(config.databaseUrl), config);
    const controller = new AbortController();
    controller.abort();
    await expect(check.check(controller.signal)).rejects.toThrow();
  });
});

describe('SqsReadinessCheck', () => {
  const sqsFor = (endpointUrl: string) => {
    const client = createSqsClient({ aws: { ...config.aws, endpointUrl } });
    toClose.push(() => client.destroy());
    return client;
  };

  it('passa com as duas filas existentes', async () => {
    const check = new SqsReadinessCheck(sqsFor(config.aws.endpointUrl ?? ''), config);
    await expect(check.check(signal())).resolves.toBeUndefined();
  });

  it('fila inexistente → erro que NÃO é de rede (reason "error")', async () => {
    const check = new SqsReadinessCheck(sqsFor(config.aws.endpointUrl ?? ''), {
      sqs: { ...config.sqs, wagerQueueName: 'nao-existe.fifo' },
    });
    const error = await check.check(signal()).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(DependencyUnreachableError);
  });

  it('endpoint inalcançável → DependencyUnreachableError', async () => {
    const check = new SqsReadinessCheck(sqsFor(CLOSED), config);
    await expect(check.check(signal())).rejects.toBeInstanceOf(DependencyUnreachableError);
  });
});
