import { describe, expect, it } from 'bun:test';
import pino from 'pino';
import type { PendingReferenceCandidate } from '../../../src/application/ports/wager-unit-of-work';
import type { PendingReferenceOutcome, ResolveOptions } from '../../../src/application/wagering/resolve-pending-references';
import { WagerSettlement } from '../../../src/application/wagering/wager-settlement';
import { WagerTransactionStatus } from '../../../src/domain/wager-transaction';
import { ObservabilityMetrics } from '../../../src/infrastructure/observability/metrics';
import {
  MAX_CONSECUTIVE_BUSY,
  MAX_CONSECUTIVE_ERRORS,
  PendingReferenceWorker,
} from '../../../src/interfaces/workers/pending-reference-worker';

const options = { batchSize: 10, pollIntervalMs: 5, gaugeIntervalMs: 5, shutdownTimeoutMs: 1_000 };
const candidate = (id: string): PendingReferenceCandidate => ({ id, walletId: `w-${id}`, playerId: 'p' });

type Step = PendingReferenceOutcome | Error;

async function total(
  counter: { get(): Promise<{ values: Array<{ value: number; labels: Record<string, unknown> }> }> },
  labels: Record<string, string> = {},
): Promise<number> {
  const { values } = await counter.get();
  return values
    .filter((v) => Object.entries(labels).every(([key, value]) => v.labels[key] === value))
    .reduce((sum, v) => sum + v.value, 0);
}

/**
 * Resolver falso: `script[id]` é a sequência de resultados de `resolve` daquela candidata (o último
 * se repete). Registra as opções de cada chamada e as chamadas a `fail`.
 */
function setup(script: Record<string, Step[]>, overrides: { findDue?: () => Promise<PendingReferenceCandidate[]>; countPending?: () => Promise<number> } = {}) {
  const lines: Array<Record<string, unknown>> = [];
  const logger = pino({ level: 'debug' }, { write: (line: string) => lines.push(JSON.parse(line) as Record<string, unknown>) });
  const metrics = new ObservabilityMetrics();
  const calls: Array<{ id: string; options: ResolveOptions | undefined }> = [];
  const failed: string[] = [];
  const worker = new PendingReferenceWorker(
    {
      findDue: overrides.findDue ?? (async () => Object.keys(script).map(candidate)),
      countPending: overrides.countPending ?? (async () => 0),
      resolve: async ({ id }, opts) => {
        calls.push({ id, options: opts });
        const steps = script[id] as Step[];
        const step = (steps.length > 1 ? steps.shift() : steps[0]) as Step;
        if (step instanceof Error) throw step;
        return step;
      },
      fail: async ({ id }) => {
        failed.push(id);
        return { type: 'failed', transactionId: id };
      },
    },
    metrics,
    options,
    logger,
  );
  return { worker, metrics, lines, calls, failed };
}

const transient = (id: string): PendingReferenceOutcome => ({ type: 'transient', transactionId: id, reason: 'lock_timeout' });
const busy = (id: string): PendingReferenceOutcome => ({ type: 'skipped', transactionId: id, reason: 'wallet_busy' });
const rescheduled = (id: string): PendingReferenceOutcome => ({ type: 'rescheduled', transactionId: id, nextReferenceCheckAt: new Date(0) });

describe('PendingReferenceWorker.runOnce', () => {
  it('conta cada resultado na métrica certa; só resolvidas, expiradas, reagendadas e falhas contam como avanço', async () => {
    const { worker, metrics } = setup({
      a: [{ type: 'resolved', transactionId: 'a', status: WagerTransactionStatus.Processed }],
      b: [{ type: 'resolved', transactionId: 'b', status: WagerTransactionStatus.Rejected }],
      c: [{ type: 'expired', transactionId: 'c' }],
      d: [rescheduled('d')],
      e: [busy('e')],
      f: [{ type: 'skipped', transactionId: 'f', reason: 'not_due' }],
      g: [transient('g')],
    });
    expect(await worker.runOnce()).toEqual({ candidates: 7, progressed: 4 });
    expect(await total(metrics.pendingReferenceResolved, { status: 'PROCESSED' })).toBe(1);
    expect(await total(metrics.pendingReferenceResolved, { status: 'REJECTED' })).toBe(1);
    expect(await total(metrics.pendingReferenceExpired)).toBe(1);
    expect(await total(metrics.pendingReferenceRescheduled)).toBe(1);
    expect(await total(metrics.pendingReferenceSkipped, { reason: 'wallet_busy' })).toBe(1);
    expect(await total(metrics.pendingReferenceSkipped, { reason: 'not_due' })).toBe(1);
    expect(await total(metrics.pendingReferenceSkipped, { reason: 'transient' })).toBe(1);
  });

  it('erro numa candidata não para as outras: log com ids (sem payload) e skipped{reason="error"}', async () => {
    const { worker, metrics, lines, calls } = setup({
      a: [new TypeError('bug')],
      b: [{ type: 'resolved', transactionId: 'b', status: WagerTransactionStatus.Processed }],
    });
    expect(await worker.runOnce()).toEqual({ candidates: 2, progressed: 1 });
    expect(calls.map((c) => c.id)).toEqual(['a', 'b']);
    expect(await total(metrics.pendingReferenceSkipped, { reason: 'error' })).toBe(1);
    expect(lines.find((line) => line.event === 'pending_reference_error')).toMatchObject({
      transactionId: 'a',
      walletId: 'w-a',
      errorName: 'TypeError',
      consecutiveErrors: 1,
    });
  });

  it(`${MAX_CONSECUTIVE_ERRORS} erros inesperados seguidos → encerra como FAILED (uma vez)`, async () => {
    const { worker, metrics, failed } = setup({ a: [new TypeError('bug')] });
    for (let i = 1; i < MAX_CONSECUTIVE_ERRORS; i++) expect(await worker.runOnce()).toEqual({ candidates: 1, progressed: 0 });
    expect(failed).toEqual([]);
    expect(await worker.runOnce()).toEqual({ candidates: 1, progressed: 1 });
    expect(failed).toEqual(['a']);
    expect(await total(metrics.pendingReferenceFailed)).toBe(1);
    expect(await total(metrics.pendingReferenceSkipped, { reason: 'error' })).toBe(MAX_CONSECUTIVE_ERRORS);
  });

  it(`${MAX_CONSECUTIVE_ERRORS} falhas transitórias seguidas NÃO levam a FAILED, nem zeram os erros já contados`, async () => {
    const steps: Step[] = [new TypeError('bug'), new TypeError('bug')];
    for (let i = 0; i < MAX_CONSECUTIVE_ERRORS; i++) steps.push(transient('a'));
    steps.push(new TypeError('bug'), new TypeError('bug'), new TypeError('bug'));
    const { worker, failed } = setup({ a: steps });

    for (let i = 0; i < 2 + MAX_CONSECUTIVE_ERRORS; i++) await worker.runOnce();
    expect(failed).toEqual([]);
    // 2 erros antes + 3 depois das transitórias = 5 seguidos.
    for (let i = 0; i < 2; i++) await worker.runOnce();
    expect(failed).toEqual([]);
    await worker.runOnce();
    expect(failed).toEqual(['a']);
  });

  it('só transitórias, muitas vezes → nunca FAILED', async () => {
    const { worker, failed } = setup({ a: [transient('a')] });
    for (let i = 0; i < 3 * MAX_CONSECUTIVE_ERRORS; i++) await worker.runOnce();
    expect(failed).toEqual([]);
  });

  it('sucesso no meio zera os erros: erros não consecutivos não levam a FAILED', async () => {
    const steps: Step[] = [];
    for (let round = 0; round < 3; round++) {
      for (let i = 0; i < MAX_CONSECUTIVE_ERRORS - 1; i++) steps.push(new TypeError('bug'));
      steps.push(rescheduled('a'));
    }
    const { worker, failed } = setup({ a: steps });
    for (let i = 0; i < 3 * MAX_CONSECUTIVE_ERRORS; i++) await worker.runOnce();
    expect(failed).toEqual([]);
  });

  it(`${MAX_CONSECUTIVE_BUSY} wallet_busy seguidos → a próxima tentativa espera o lock; depois volta a SKIP LOCKED`, async () => {
    const steps: Step[] = [];
    for (let i = 0; i < MAX_CONSECUTIVE_BUSY; i++) steps.push(busy('a'));
    steps.push(rescheduled('a'));
    const { worker, calls } = setup({ a: steps });
    for (let i = 0; i < MAX_CONSECUTIVE_BUSY + 2; i++) await worker.runOnce();
    expect(calls.map((c) => c.options?.waitForWallet)).toEqual([
      ...Array<boolean>(MAX_CONSECUTIVE_BUSY).fill(false),
      true,
      false,
    ]);
  });

  it('keepGoing false → para antes da próxima candidata', async () => {
    const { worker, calls } = setup({ a: [{ type: 'expired', transactionId: 'a' }], b: [{ type: 'expired', transactionId: 'b' }] });
    let n = 0;
    expect(await worker.runOnce(() => n++ === 0)).toEqual({ candidates: 2, progressed: 1 });
    expect(calls.map((c) => c.id)).toEqual(['a']);
  });
});

describe('PendingReferenceWorker loop', () => {
  async function until(check: () => boolean, timeoutMs = 2_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (!check()) {
      if (Date.now() > deadline) throw new Error('condição não atingida');
      await Bun.sleep(5);
    }
  }

  it('busca falhando (banco fora) não mata o loop: loga, pausa e volta quando o banco volta', async () => {
    let down = 2;
    let found = 0;
    const { worker, lines } = setup(
      {},
      {
        findDue: async () => {
          if (down > 0) {
            down--;
            throw new Error('ECONNREFUSED');
          }
          found++;
          return [];
        },
      },
    );
    worker.start();
    try {
      await until(() => found > 0, 8_000); // pausas reais de 1s e 2s (errorPauseMs)
    } finally {
      await worker.stop();
    }
    const failures = lines.filter((line) => line.event === 'pending_reference_cycle_failed');
    expect(failures.map((line) => line.pauseMs)).toEqual([1_000, 2_000]);
  }, 10_000);

  it('gauge falhando só loga; o gauge é medido por intervalo mesmo com carga', async () => {
    let counts = 0;
    const { worker, lines, metrics } = setup(
      { a: [rescheduled('a')] },
      {
        // Cede ao event loop como o banco real faria; senão o laço sob carga só roda microtasks.
        findDue: async () => {
          await Bun.sleep(1);
          return [candidate('a')];
        },
        countPending: async () => {
          counts++;
          if (counts === 1) throw new Error('boom');
          return 7;
        },
      },
    );
    worker.start();
    try {
      // Sempre há avanço (sem espera do poll), e mesmo assim o gauge é atualizado.
      await until(() => counts >= 2);
    } finally {
      await worker.stop();
    }
    expect(lines.some((line) => line.event === 'pending_reference_gauge_failed')).toBe(true);
    expect(await total(metrics.pendingReferences)).toBe(7);
  });

  it('stop() com uma candidata presa além do prazo devolve no timeout e loga', async () => {
    let release!: () => void;
    const stuck = new Promise<PendingReferenceOutcome>((resolve) => {
      release = () => resolve(rescheduled('a'));
    });
    const lines: Array<Record<string, unknown>> = [];
    const logger = pino({ level: 'info' }, { write: (line: string) => lines.push(JSON.parse(line) as Record<string, unknown>) });
    let entered = false;
    const worker = new PendingReferenceWorker(
      {
        findDue: async () => [candidate('a')],
        countPending: async () => 0,
        resolve: () => {
          entered = true;
          return stuck;
        },
        fail: async () => ({ type: 'failed', transactionId: 'a' }),
      },
      new ObservabilityMetrics(),
      { ...options, shutdownTimeoutMs: 50 },
      logger,
    );
    worker.start();
    await until(() => entered);
    await worker.stop();
    expect(lines.some((line) => line.event === 'pending_reference_worker_shutdown_timeout')).toBe(true);
    release();
  });
});

describe('WagerSettlement', () => {
  it.each([0, -1, 1.5])('TTL %p é rejeitado', (ttl) => {
    expect(() => new WagerSettlement({ uuid: () => 'x' }, ttl)).toThrow(RangeError);
  });
});
