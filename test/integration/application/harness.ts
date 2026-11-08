import type { MikroORM } from '@mikro-orm/postgresql';
import { randomUUID } from 'node:crypto';
import type { Clock } from '../../../src/application/ports/clock';
import {
  ProcessWagerTransaction,
  type ProcessWagerTransactionCommand,
  type ProcessWagerTransactionResult,
  type WagerTransactionPayload,
} from '../../../src/application/wagering/process-wager-transaction';
import { WagerSettlement } from '../../../src/application/wagering/wager-settlement';
import { WalletMutex } from '../../../src/application/wagering/wallet-mutex';
import { LoggingLockConflictTelemetry } from '../../../src/infrastructure/observability/lock-conflict-telemetry';
import { ObservabilityMetrics } from '../../../src/infrastructure/observability/metrics';
import { MikroOrmWagerUnitOfWork, WAGER_LOCK_TIMEOUT_MS } from '../../../src/infrastructure/persistence/mikro-orm-wager-unit-of-work';
import { randomIdGenerator } from '../../../src/infrastructure/system-adapters';
import { T0 } from '../persistence/db';
import { captureLogger } from '../workers/outbox-harness';

const fixedClock: Clock = { now: () => new Date(T0) };

/** Prazo das PENDING_REFERENCE nos testes: o mesmo padrão do config (PENDING_REFERENCE_TTL_MS). */
export const TEST_REFERENCE_TTL_MS = 60 * 60_000;

export function buildUseCase(orm: MikroORM, options: { lockTimeoutMs?: number } = {}) {
  const metrics = new ObservabilityMetrics();
  const log = captureLogger();
  const useCase = new ProcessWagerTransaction(
    new MikroOrmWagerUnitOfWork(orm.em, options.lockTimeoutMs ?? WAGER_LOCK_TIMEOUT_MS),
    fixedClock,
    randomIdGenerator,
    new LoggingLockConflictTelemetry(metrics, log.logger),
    new WagerSettlement(randomIdGenerator, TEST_REFERENCE_TTL_MS),
    // Um mutex por use case: cada buildUseCase faz o papel de uma instância.
    new WalletMutex(),
  );
  return { useCase, metrics, logs: log.lines };
}

export interface WalletRef {
  walletId: string;
  playerId: string;
}

/** Comando com key default `{providerId}:{externalTransactionId}` (CHALLENGE §9). */
export function command(
  wallet: WalletRef,
  payload: Partial<WagerTransactionPayload> = {},
  extra: Partial<ProcessWagerTransactionCommand> = {},
): ProcessWagerTransactionCommand {
  const providerId = (payload.providerId as string | undefined) ?? 'provider-a';
  const externalTransactionId = (payload.externalTransactionId as string | undefined) ?? `ext-${randomUUID()}`;
  return {
    idempotencyKey: `${providerId}:${externalTransactionId}`,
    correlationId: 'corr-1',
    payload: {
      providerId,
      externalTransactionId,
      playerId: wallet.playerId,
      walletId: wallet.walletId,
      roundId: 'round-1',
      gameId: 'game-1',
      kind: 'BET',
      money: { amount: '10.00', currency: 'BRL' },
      ...payload,
    },
    ...extra,
  };
}

/**
 * Reenvia a MESMA requisição enquanto a falha for transitória, como um provedor faria:
 * limite de tentativas e pequeno backoff com jitter (5–25 ms) para não reenviar em rajada.
 */
export async function untilSettled(
  run: () => Promise<ProcessWagerTransactionResult>,
  maxAttempts = 50,
): Promise<ProcessWagerTransactionResult> {
  for (let attempt = 1; ; attempt++) {
    const result = await run();
    if (result.type !== 'TransientFailure' || attempt >= maxAttempts) return result;
    await Bun.sleep(5 + Math.floor(Math.random() * 20));
  }
}

export async function walletBalance(orm: MikroORM, walletId: string): Promise<string> {
  const rows = await orm.em.getKnex()('wallets').select('balance').where({ id: walletId });
  return rows[0].balance as string;
}

export async function countRows(orm: MikroORM, table: string, where: Record<string, unknown> = {}): Promise<number> {
  const [row] = await orm.em.getKnex()(table).where(where).count({ n: '*' });
  return Number(row?.n);
}
