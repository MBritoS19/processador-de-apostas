/**
 * Cenário obrigatório do CHALLENGE (§13): wallet com saldo 100 e duas BETs de 80 em paralelo
 * → exatamente uma PROCESSED, uma REJECTED (INSUFFICIENT_BALANCE) e saldo final 20.
 *
 * Sobe a aplicação neste processo (banco do `.env`, porta livre) e fala com ela por HTTP.
 * Os loops de fundo ficam desligados: o cenário não precisa deles, e os eventos ficam na outbox
 * até a aplicação subir de verdade. Exige `docker compose up -d --wait` e `bun run migration:up`.
 */
import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { AppModule } from '../src/app.module';
import { loadConfig } from '../src/infrastructure/config/app-config';

process.env.SQS_CONSUMER_ENABLED = 'false';
process.env.OUTBOX_PUBLISHER_ENABLED = 'false';
process.env.PENDING_REFERENCE_WORKER_ENABLED = 'false';

type Json = Record<string, any>;

const app = await NestFactory.create(AppModule.register(loadConfig()), { logger: false });
await app.listen(0);
const { port } = app.getHttpServer().address() as { port: number };
const base = `http://127.0.0.1:${port}`;

async function call(method: string, path: string, body?: Json, headers: Record<string, string> = {}) {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: { 'content-type': 'application/json', ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  return { status: response.status, body: (text ? JSON.parse(text) : {}) as Json };
}

let ok = false;
try {
  // Sufixo único: a demo pode rodar várias vezes no mesmo banco (a idempotência é persistida).
  const run = crypto.randomUUID().slice(0, 8);
  const playerId = `demo-player-${run}`;

  const opened = await call('POST', '/wallets', { playerId, initialBalance: { amount: '100.00', currency: 'BRL' } });
  if (opened.status !== 201) throw new Error(`abertura da wallet: HTTP ${opened.status} ${JSON.stringify(opened.body)}`);
  const walletId = opened.body.id as string;
  console.log(`wallet ${walletId} aberta com saldo ${opened.body.balance.amount}`);

  const bet = (externalTransactionId: string) =>
    call(
      'POST',
      '/wagering/transactions',
      {
        providerId: 'demo-provider',
        externalTransactionId,
        playerId,
        walletId,
        roundId: `round-${run}`,
        gameId: 'demo-game',
        kind: 'BET',
        money: { amount: '80.00', currency: 'BRL' },
      },
      { 'idempotency-key': `demo-provider:${externalTransactionId}` },
    );

  console.log('enviando duas BETs de 80.00 em paralelo...');
  const results = await Promise.all([bet(`bet-a-${run}`), bet(`bet-b-${run}`)]);
  results.forEach((r, i) =>
    console.log(`  BET ${i + 1}: HTTP ${r.status} ${r.body.status}${r.body.failureCode ? ` (${r.body.failureCode})` : ''}`),
  );

  const wallet = await call('GET', `/wallets/${walletId}`);
  const reconciliation = await call('POST', `/wallets/${walletId}/reconciliation`);
  console.log(`saldo final: ${wallet.body.balance.amount}`);
  console.log(`reconciliação: consistent=${reconciliation.body.consistent}`);

  const statuses = results.map((r) => r.body.status).sort();
  const rejected = results.find((r) => r.body.status === 'REJECTED');
  ok =
    statuses[0] === 'PROCESSED' &&
    statuses[1] === 'REJECTED' &&
    rejected?.body.failureCode === 'INSUFFICIENT_BALANCE' &&
    wallet.body.balance.amount === '20.00' &&
    reconciliation.body.consistent === true;
  console.log(ok ? 'OK: uma PROCESSED, uma REJECTED, saldo 20.00' : 'FALHOU: resultado diferente do esperado');
} catch (error) {
  console.error(`demo falhou: ${error instanceof Error ? error.message : String(error)}`);
} finally {
  await app.close();
}
process.exit(ok ? 0 : 1);
