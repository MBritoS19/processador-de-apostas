import 'reflect-metadata';
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import type { INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import { AppModule } from '../../../src/app.module';
import { AuthGuard } from '../../../src/interfaces/http/auth.guard';
import { loadConfig, type AppConfig } from '../../../src/infrastructure/config/app-config';

/** Porta onde nada escuta: a conexão é recusada na hora (dependência real fora do ar, não mock). */
const CLOSED_PORT = 1;

async function startApp(config: AppConfig): Promise<{ app: INestApplication; baseUrl: string }> {
  // abortOnError: false → falha de boot vira erro de teste, em vez de process.exit silencioso.
  const app = await NestFactory.create(AppModule.register(config), { logger: false, abortOnError: false });
  await app.listen(0);
  const address = app.getHttpServer().address() as { port: number };
  return { app, baseUrl: `http://127.0.0.1:${address.port}` };
}

function withApp(config: () => AppConfig, body: (url: () => string) => void): void {
  let app: INestApplication;
  let baseUrl: string;
  beforeAll(async () => {
    ({ app, baseUrl } = await startApp(config()));
  });
  afterAll(async () => {
    await app.close();
  });
  body(() => baseUrl);
}

type ReadyBody = { status: string; dependencies: Record<string, { status: string; reason?: string }> };

describe('health checks (Postgres e LocalStack reais)', () => {
  withApp(loadConfig, (url) => {
    it('GET /health/live → 200', async () => {
      const res = await fetch(`${url()}/health/live`);
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ status: 'alive' });
    });

    it('GET /health/ready → 200 com Postgres e SQS de pé', async () => {
      const res = await fetch(`${url()}/health/ready`);
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({
        status: 'ready',
        dependencies: { postgres: { status: 'up' }, sqs: { status: 'up' } },
      });
    });
  });
});

describe('health checks com SQS inalcançável', () => {
  withApp(
    () => {
      const base = loadConfig();
      return { ...base, aws: { ...base.aws, endpointUrl: `http://127.0.0.1:${CLOSED_PORT}` } };
    },
    (url) => {
      it('GET /health/ready → 503, sqs down com reason fechado e sem detalhes de conexão', async () => {
        const res = await fetch(`${url()}/health/ready`);
        expect(res.status).toBe(503);

        const raw = await res.text();
        const body = JSON.parse(raw) as ReadyBody;
        expect(body.status).toBe('not_ready');
        expect(body.dependencies['postgres']).toEqual({ status: 'up' });
        expect(body.dependencies['sqs']?.status).toBe('down');
        expect(['unreachable', 'timeout']).toContain(body.dependencies['sqs']?.reason ?? '');
        expect(raw).not.toContain('127.0.0.1');
        expect(raw).not.toContain('ECONNREFUSED');
      });

      it('GET /health/live continua 200 (liveness não depende de terceiros)', async () => {
        expect((await fetch(`${url()}/health/live`)).status).toBe(200);
      });
    },
  );
});

describe('health checks com Postgres inalcançável', () => {
  withApp(
    () => ({ ...loadConfig(), databaseUrl: `postgres://wagering:wagering@127.0.0.1:${CLOSED_PORT}/wagering_test` }),
    (url) => {
      it('GET /health/ready → 503 com postgres down/unreachable e sqs up', async () => {
        const res = await fetch(`${url()}/health/ready`);
        expect(res.status).toBe(503);

        const raw = await res.text();
        expect(JSON.parse(raw)).toEqual({
          status: 'not_ready',
          dependencies: { postgres: { status: 'down', reason: 'unreachable' }, sqs: { status: 'up' } },
        });
        expect(raw).not.toContain('wagering:wagering');
      });
    },
  );
});

// CHALLENGE §2/§9: health não exige autenticação. Com o AuthGuard negando tudo (como um IdP real
// recusaria uma requisição sem token), o health continua aberto e o wagering é negado.
describe('health checks fora do AuthGuard', () => {
  let app: INestApplication;
  let baseUrl: string;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule.register(loadConfig())] })
      .overrideGuard(AuthGuard)
      .useValue({ canActivate: () => false })
      .compile();
    app = moduleRef.createNestApplication({ logger: false });
    await app.listen(0);
    baseUrl = `http://127.0.0.1:${(app.getHttpServer().address() as { port: number }).port}`;
  });

  afterAll(async () => {
    await app.close();
  });

  it('GET /health/live e /health/ready → 200 sem credencial; endpoints de wagering → 403', async () => {
    expect((await fetch(`${baseUrl}/health/live`)).status).toBe(200);
    expect((await fetch(`${baseUrl}/health/ready`)).status).toBe(200);
    // O guard está mesmo ativo: as rotas protegidas são negadas.
    expect((await fetch(`${baseUrl}/wallets/00000000-0000-0000-0000-000000000000`)).status).toBe(403);
    const submit = await fetch(`${baseUrl}/wagering/transactions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'idempotency-key': 'k' },
      body: '{}',
    });
    expect(submit.status).toBe(403);
  });
});
