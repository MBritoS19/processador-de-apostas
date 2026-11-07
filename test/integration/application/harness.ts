import type { MikroORM } from '@mikro-orm/postgresql';
import { randomUUID } from 'node:crypto';
import type { Clock } from '../../../src/application/ports/clock';
import {
  ProcessWagerTransaction,
  type ProcessWagerTransactionCommand,
  type ProcessWagerTransactionResult,
  type WagerTransactionPayload,
} from '../../../src/application/wagering/process-wager-transaction';
import { LoggingLockConflictTelemetry } from '../../../src/infrastructure/observability/lock-conflict-telemetry';
import { MikroOrmWagerUnitOfWork } from '../../../src/infrastructure/persistence/mikro-orm-wager-unit-of-work';
import { randomIdGenerator } from '../../../src/infrastructure/system-clock';
import { T0 } from '../persistence/db';

export const fixedClock: Clock = { now: () => new Date(T0) };

export function buildUseCase(orm: MikroORM, options: { lockTimeoutMs?: number } = {}) {
  const logs: string[] = [];
  const telemetry = new LoggingLockConflictTelemetry((line) => logs.push(line));
  const useCase = new ProcessWagerTransaction(
    new MikroOrmWagerUnitOfWork(orm.em, options.lockTimeoutMs),
    fixedClock,
    randomIdGenerator,
    telemetry,
  );
  return { useCase, telemetry, logs };
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

/** Reenvia enquanto a falha for transitória, como um provedor faria (com limite). */
export async function untilSettled(
  run: () => Promise<ProcessWagerTransactionResult>,
  maxAttempts = 50,
): Promise<ProcessWagerTransactionResult> {
  for (let attempt = 1; ; attempt++) {
    const result = await run();
    if (result.type !== 'TransientFailure' || attempt >= maxAttempts) return result;
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
