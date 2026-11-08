import { describe, expect, it } from 'bun:test';
import { randomUUID } from 'node:crypto';
import {
  TransientPersistenceError,
  WalletVersionConflictError,
  type WagerProcessingRepository,
  type WagerUnitOfWork,
} from '../../../src/application/ports/wager-unit-of-work';
import {
  ProcessWagerTransaction,
  type ProcessWagerTransactionCommand,
} from '../../../src/application/wagering/process-wager-transaction';
import pino from 'pino';
import { WagerSettlement } from '../../../src/application/wagering/wager-settlement';
import { LoggingLockConflictTelemetry } from '../../../src/infrastructure/observability/lock-conflict-telemetry';
import { ObservabilityMetrics } from '../../../src/infrastructure/observability/metrics';

/** UoW falso: conta as chamadas e lança o erro configurado. A lógica com banco é testada na integração. */
function fakeUnitOfWork(error: Error = new Error('não deveria abrir transação')): WagerUnitOfWork & { calls: number } {
  return {
    calls: 0,
    async run<T>(_work: (repository: WagerProcessingRepository) => Promise<T>): Promise<T> {
      this.calls++;
      throw error;
    },
  };
}

function setup(error?: Error) {
  const unitOfWork = fakeUnitOfWork(error);
  const logs: Array<Record<string, unknown>> = [];
  const logger = pino({ level: 'info' }, { write: (line: string) => logs.push(JSON.parse(line) as Record<string, unknown>) });
  const metrics = new ObservabilityMetrics();
  const ids = { uuid: randomUUID };
  const telemetry = new LoggingLockConflictTelemetry(metrics, logger);
  const useCase = new ProcessWagerTransaction(unitOfWork, { now: () => new Date(0) }, ids, telemetry, new WagerSettlement(ids, 60 * 60_000));
  return { useCase, unitOfWork, metrics, logs };
}

/** Conflitos de lock na métrica, opcionalmente filtrados por reason. */
async function lockConflicts(metrics: ObservabilityMetrics, reason?: string): Promise<number> {
  const { values } = await metrics.lockConflicts.get();
  return values.filter((v) => reason === undefined || v.labels.reason === reason).reduce((sum, v) => sum + v.value, 0);
}

const walletId = '0192f291-27dd-7d3f-8071-5f8685deef37';
const cmd = (payload: Record<string, unknown> = {}): ProcessWagerTransactionCommand => ({
  idempotencyKey: 'provider-a:tx-1',
  correlationId: 'corr-1',
  payload: {
    providerId: 'provider-a',
    externalTransactionId: 'tx-1',
    playerId: 'player-1',
    walletId,
    roundId: 'round-1',
    gameId: 'game-1',
    kind: 'BET',
    money: { amount: '10.00', currency: 'BRL' },
    ...payload,
  },
});

describe('ProcessWagerTransaction — validação antes de qualquer gravação', () => {
  it.each(['BET', 'WIN', 'REFUND', 'ROLLBACK'])('%s com valor 0.00 → InvalidInput sem abrir transação', async (kind) => {
    const { useCase, unitOfWork } = setup();
    const reference = kind === 'BET' ? {} : { referenceExternalTransactionId: 'ref-1' };
    const result = await useCase.execute(cmd({ kind, ...reference, money: { amount: '0.00', currency: 'BRL' } }));
    expect(result.type).toBe('InvalidInput');
    expect(unitOfWork.calls).toBe(0);
  });

  it.each([null, undefined, 'texto'])('payload %p → InvalidInput', async (payload) => {
    const { useCase, unitOfWork } = setup();
    const command = { ...cmd(), payload } as unknown as ProcessWagerTransactionCommand;
    expect(await useCase.execute(command)).toEqual({ type: 'InvalidInput', reason: 'payload é obrigatório' });
    expect(unitOfWork.calls).toBe(0);
  });

  it('providerId "internal" e key com prefixo "opening:" são reservados → InvalidInput', async () => {
    const { useCase, unitOfWork } = setup();
    expect((await useCase.execute(cmd({ providerId: 'internal' }))).type).toBe('InvalidInput');
    expect((await useCase.execute({ ...cmd(), idempotencyKey: `opening:${walletId}` })).type).toBe('InvalidInput');
    expect(unitOfWork.calls).toBe(0);
  });

  it('idempotencyKey vazia → InvalidInput', async () => {
    const { useCase, unitOfWork } = setup();
    expect((await useCase.execute({ ...cmd(), idempotencyKey: '' })).type).toBe('InvalidInput');
    expect(unitOfWork.calls).toBe(0);
  });
});

describe('ProcessWagerTransaction — falhas de concorrência', () => {
  it('version divergente no UPDATE → TransientFailure, contador e log estruturado sem payload', async () => {
    const { useCase, metrics, logs } = setup(new WalletVersionConflictError(walletId));
    expect(await useCase.execute(cmd())).toEqual({ type: 'TransientFailure', reason: 'version_conflict' });
    expect(await lockConflicts(metrics, 'version_conflict')).toBe(1);
    expect(logs).toHaveLength(1);
    const { level, event, reason, walletId: loggedWallet, correlationId, ...rest } = logs[0] ?? {};
    expect(Object.keys(rest).sort()).toEqual(['hostname', 'msg', 'pid', 'time']);
    expect({ level, event, reason, walletId: loggedWallet, correlationId }).toEqual({
      level: 40,
      event: 'wallet_lock_conflict',
      reason: 'version_conflict',
      walletId,
      correlationId: 'corr-1',
    });
  });

  it.each(['lock_timeout', 'deadlock'] as const)('%s → TransientFailure e conflito contado', async (reason) => {
    const { useCase, metrics } = setup(new TransientPersistenceError(reason));
    expect(await useCase.execute(cmd())).toEqual({ type: 'TransientFailure', reason });
    expect(await lockConflicts(metrics, reason)).toBe(1);
  });

  it('banco indisponível → TransientFailure sem contar conflito de lock', async () => {
    const { useCase, metrics } = setup(new TransientPersistenceError('unavailable'));
    expect(await useCase.execute(cmd())).toEqual({ type: 'TransientFailure', reason: 'unavailable' });
    expect(await lockConflicts(metrics)).toBe(0);
  });

  it('erro desconhecido é relançado (bug, não falha transitória)', async () => {
    const { useCase } = setup(new Error('boom'));
    await expect(useCase.execute(cmd())).rejects.toThrow('boom');
  });
});
