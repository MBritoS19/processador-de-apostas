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
import { WalletMutex, type Release } from '../../../src/application/wagering/wallet-mutex';
import type { Clock } from '../../../src/application/ports/clock';
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

/**
 * UoW falso em que a leitura de idempotência antes do lock (1ª chamada) não acha nada, e o
 * caminho com lock (chamadas seguintes) lança `error`.
 */
function lockPathFailing(error: Error): WagerUnitOfWork & { calls: number } {
  return {
    calls: 0,
    async run<T>(work: (repository: WagerProcessingRepository) => Promise<T>): Promise<T> {
      this.calls++;
      if (this.calls === 1) return work({ findByIdempotency: async () => [] } as unknown as WagerProcessingRepository);
      throw error;
    },
  };
}

function setup(
  error?: Error,
  unitOfWork: WagerUnitOfWork & { calls: number } = fakeUnitOfWork(error),
  { mutex = new WalletMutex(), clock = { now: () => new Date(0) } }: { mutex?: WalletMutex; clock?: Clock } = {},
) {
  const logs: Array<Record<string, unknown>> = [];
  const logger = pino({ level: 'info' }, { write: (line: string) => logs.push(JSON.parse(line) as Record<string, unknown>) });
  const metrics = new ObservabilityMetrics();
  const ids = { uuid: randomUUID };
  const telemetry = new LoggingLockConflictTelemetry(metrics, logger);
  const useCase = new ProcessWagerTransaction(unitOfWork, clock, ids, telemetry, new WagerSettlement(ids, 60 * 60_000), mutex);
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

  it('lock_timeout no caminho com lock: 1 tentativa extra, depois TransientFailure', async () => {
    const { useCase, unitOfWork, metrics } = setup(undefined, lockPathFailing(new TransientPersistenceError('lock_timeout')));
    expect(await useCase.execute(cmd())).toEqual({ type: 'TransientFailure', reason: 'lock_timeout' });
    // 1 leitura sem lock + 2 tentativas com lock; cada estouro do lock é contado.
    expect(unitOfWork.calls).toBe(3);
    expect(await lockConflicts(metrics, 'lock_timeout')).toBe(2);
  });

  it.each(['deadlock', 'serialization', 'pool_exhausted', 'unavailable'] as const)('%s no caminho com lock: sem tentativa extra', async (reason) => {
    const { useCase, unitOfWork } = setup(undefined, lockPathFailing(new TransientPersistenceError(reason)));
    expect(await useCase.execute(cmd())).toEqual({ type: 'TransientFailure', reason });
    expect(unitOfWork.calls).toBe(2);
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

/** Mutex real que registra a devolução e o timeout pedido; `afterAcquire` simula o tempo de espera. */
class SpyMutex extends WalletMutex {
  readonly timeouts: number[] = [];
  constructor(
    private readonly events: string[] = [],
    private readonly afterAcquire: () => void = () => {},
  ) {
    super();
  }
  override async acquire(walletId: string, timeoutMs: number): Promise<Release | undefined> {
    this.timeouts.push(timeoutMs);
    const release = await super.acquire(walletId, timeoutMs);
    this.afterAcquire();
    if (release === undefined) return undefined;
    return () => {
      this.events.push('release');
      release();
    };
  }
}

/** Relógio controlado pelo teste. */
function manualClock(): Clock & { advance(ms: number): void } {
  let t = 0;
  return {
    now: () => new Date(t),
    advance: (ms) => {
      t += ms;
    },
  };
}

/**
 * Leitura sem lock vazia (1ª chamada). No caminho com lock, `attempt(n)` decide o desfecho de cada
 * tentativa; `commit`/`rollback` é registrado quando a transação termina, antes de `run` voltar.
 */
function lockPath(events: string[], attempt: (n: number) => Promise<'commit' | Error>) {
  const uow = {
    calls: 0,
    maxLockTimeouts: [] as Array<number | undefined>,
    async run<T>(work: (repository: WagerProcessingRepository) => Promise<T>, options?: { maxLockTimeoutMs?: number }): Promise<T> {
      uow.calls++;
      if (uow.calls === 1) return work({ findByIdempotency: async () => [] } as unknown as WagerProcessingRepository);
      uow.maxLockTimeouts.push(options?.maxLockTimeoutMs);
      const outcome = await attempt(uow.calls - 1);
      await Bun.sleep(5);
      if (outcome === 'commit') {
        events.push('commit');
        const processed = { type: 'Processed', transactionId: 'tx', status: 'PROCESSED', balance: { amount: '1.00', currency: 'BRL' }, idempotentReplay: false };
        return processed as T;
      }
      events.push('rollback');
      throw outcome;
    },
  };
  return uow;
}

describe('ProcessWagerTransaction — mutex local por wallet', () => {
  it('devolve o mutex só depois do COMMIT', async () => {
    const events: string[] = [];
    const mutex = new SpyMutex(events);
    const { useCase } = setup(undefined, lockPath(events, async () => 'commit'), { mutex });
    expect((await useCase.execute(cmd())).type).toBe('Processed');
    expect(events).toEqual(['commit', 'release']);
    expect(mutex.size).toBe(0);
  });

  it('devolve o mutex só depois do ROLLBACK (erro transitório)', async () => {
    const events: string[] = [];
    const mutex = new SpyMutex(events);
    const { useCase } = setup(undefined, lockPath(events, async () => new TransientPersistenceError('deadlock')), { mutex });
    expect(await useCase.execute(cmd())).toEqual({ type: 'TransientFailure', reason: 'deadlock' });
    expect(events).toEqual(['rollback', 'release']);
    expect(mutex.size).toBe(0);
  });

  it('mutex não sai no orçamento → local_lock_timeout, contado, sem abrir transação', async () => {
    const timeouts: number[] = [];
    const busy = { acquire: async (_walletId: string, timeoutMs: number) => (timeouts.push(timeoutMs), undefined) } as unknown as WalletMutex;
    const uow = lockPath([], async () => 'commit');
    const { useCase, metrics } = setup(undefined, uow, { mutex: busy });
    expect(await useCase.execute(cmd())).toEqual({ type: 'TransientFailure', reason: 'local_lock_timeout' });
    // Orçamento de 2s menos o mínimo de 100ms para uma tentativa no banco.
    expect(timeouts).toEqual([1_900]);
    expect(uow.calls).toBe(1);
    expect(await lockConflicts(metrics, 'local_lock_timeout')).toBe(1);
  });

  it('sobrou menos de 100ms depois do mutex → local_lock_timeout sem abrir transação, e devolve o mutex', async () => {
    const events: string[] = [];
    const clock = manualClock();
    const mutex = new SpyMutex(events, () => clock.advance(1_950));
    const uow = lockPath(events, async () => 'commit');
    const { useCase, metrics } = setup(undefined, uow, { mutex, clock });
    expect(await useCase.execute(cmd())).toEqual({ type: 'TransientFailure', reason: 'local_lock_timeout' });
    expect(uow.calls).toBe(1);
    expect(events).toEqual(['release']);
    expect(mutex.size).toBe(0);
    expect(await lockConflicts(metrics, 'local_lock_timeout')).toBe(1);
  });

  it('a espera no mutex desconta do orçamento do lock no banco', async () => {
    const events: string[] = [];
    const clock = manualClock();
    const mutex = new SpyMutex(events, () => clock.advance(600));
    // 1ª tentativa estoura depois de 1s; a 2ª recebe só o que sobra (2000 − 600 − 1000).
    const uow = lockPath(events, async (n) => {
      if (n > 1) return 'commit';
      clock.advance(1_000);
      return new TransientPersistenceError('lock_timeout');
    });
    const { useCase } = setup(undefined, uow, { mutex, clock });
    expect((await useCase.execute(cmd())).type).toBe('Processed');
    expect(uow.maxLockTimeouts).toEqual([1_400, 400]);
    expect(events).toEqual(['rollback', 'commit', 'release']);
  });

  it('sem orçamento para a tentativa extra → lock_timeout, sem 2ª tentativa', async () => {
    const clock = manualClock();
    const mutex = new SpyMutex([], () => clock.advance(900));
    const uow = lockPath([], async () => {
      clock.advance(1_050);
      return new TransientPersistenceError('lock_timeout');
    });
    const { useCase, metrics } = setup(undefined, uow, { mutex, clock });
    expect(await useCase.execute(cmd())).toEqual({ type: 'TransientFailure', reason: 'lock_timeout' });
    expect(uow.maxLockTimeouts).toEqual([1_100]);
    expect(await lockConflicts(metrics, 'lock_timeout')).toBe(1);
    expect(mutex.size).toBe(0);
  });

  it('conflito achado na leitura sem lock é decidido antes do mutex', async () => {
    const mutex = new SpyMutex();
    const known = { id: 'tx-0', idempotencyKey: 'provider-a:tx-1', matchesPayload: () => false };
    const uow = {
      calls: 0,
      async run<T>(work: (repository: WagerProcessingRepository) => Promise<T>): Promise<T> {
        uow.calls++;
        return work({ findByIdempotency: async () => [known] } as unknown as WagerProcessingRepository);
      },
    };
    const { useCase } = setup(undefined, uow, { mutex });
    expect(await useCase.execute(cmd())).toEqual({ type: 'IdempotencyConflict', existingTransactionId: 'tx-0' });
    expect(mutex.timeouts).toEqual([]);
    expect(uow.calls).toBe(1);
  });
});
