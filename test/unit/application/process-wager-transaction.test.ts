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
import { LoggingLockConflictTelemetry } from '../../../src/infrastructure/observability/lock-conflict-telemetry';

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
  const logs: string[] = [];
  const telemetry = new LoggingLockConflictTelemetry((line) => logs.push(line));
  const useCase = new ProcessWagerTransaction(unitOfWork, { now: () => new Date(0) }, { uuid: randomUUID }, telemetry);
  return { useCase, unitOfWork, telemetry, logs };
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

  it('idempotencyKey vazia → InvalidInput', async () => {
    const { useCase, unitOfWork } = setup();
    expect((await useCase.execute({ ...cmd(), idempotencyKey: '' })).type).toBe('InvalidInput');
    expect(unitOfWork.calls).toBe(0);
  });
});

describe('ProcessWagerTransaction — falhas de concorrência', () => {
  it('version divergente no UPDATE → TransientFailure, contador e log estruturado sem payload', async () => {
    const { useCase, telemetry, logs } = setup(new WalletVersionConflictError(walletId));
    expect(await useCase.execute(cmd())).toEqual({ type: 'TransientFailure', reason: 'version_conflict' });
    expect(telemetry.count('version_conflict')).toBe(1);
    expect(logs).toHaveLength(1);
    expect(JSON.parse(logs[0] ?? '{}')).toEqual({
      level: 'warn',
      event: 'wallet_lock_conflict',
      reason: 'version_conflict',
      walletId,
      correlationId: 'corr-1',
    });
  });

  it.each(['lock_timeout', 'deadlock'] as const)('%s → TransientFailure e conflito contado', async (reason) => {
    const { useCase, telemetry } = setup(new TransientPersistenceError(reason));
    expect(await useCase.execute(cmd())).toEqual({ type: 'TransientFailure', reason });
    expect(telemetry.count(reason)).toBe(1);
  });

  it('banco indisponível → TransientFailure sem contar conflito de lock', async () => {
    const { useCase, telemetry } = setup(new TransientPersistenceError('unavailable'));
    expect(await useCase.execute(cmd())).toEqual({ type: 'TransientFailure', reason: 'unavailable' });
    expect(telemetry.count()).toBe(0);
  });

  it('erro desconhecido é relançado (bug, não falha transitória)', async () => {
    const { useCase } = setup(new Error('boom'));
    await expect(useCase.execute(cmd())).rejects.toThrow('boom');
  });
});
