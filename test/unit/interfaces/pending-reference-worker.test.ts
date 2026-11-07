import { describe, expect, it } from 'bun:test';
import pino from 'pino';
import type { PendingReferenceCandidate } from '../../../src/application/ports/wager-unit-of-work';
import type { PendingReferenceOutcome } from '../../../src/application/wagering/resolve-pending-references';
import { WagerSettlement } from '../../../src/application/wagering/wager-settlement';
import { WagerTransactionStatus } from '../../../src/domain/wager-transaction';
import { ObservabilityMetrics } from '../../../src/infrastructure/observability/metrics';
import { PendingReferenceWorker } from '../../../src/interfaces/workers/pending-reference-worker';

const options = { batchSize: 10, pollIntervalMs: 10, gaugeIntervalMs: 10, shutdownTimeoutMs: 1_000 };
const candidate = (id: string): PendingReferenceCandidate => ({ id, walletId: `w-${id}`, playerId: 'p' });

async function total(
  counter: { get(): Promise<{ values: Array<{ value: number; labels: Record<string, unknown> }> }> },
  labels: Record<string, string> = {},
): Promise<number> {
  const { values } = await counter.get();
  return values
    .filter((v) => Object.entries(labels).every(([key, value]) => v.labels[key] === value))
    .reduce((sum, v) => sum + v.value, 0);
}

function setup(outcomes: Record<string, PendingReferenceOutcome | Error>) {
  const lines: Array<Record<string, unknown>> = [];
  const logger = pino({ level: 'debug' }, { write: (line: string) => lines.push(JSON.parse(line) as Record<string, unknown>) });
  const metrics = new ObservabilityMetrics();
  const resolved: string[] = [];
  const worker = new PendingReferenceWorker(
    {
      findDue: async () => Object.keys(outcomes).map(candidate),
      countPending: async () => 0,
      resolve: async ({ id }) => {
        resolved.push(id);
        const outcome = outcomes[id] as PendingReferenceOutcome | Error;
        if (outcome instanceof Error) throw outcome;
        return outcome;
      },
    },
    metrics,
    options,
    logger,
  );
  return { worker, metrics, lines, resolved };
}

describe('PendingReferenceWorker.runOnce', () => {
  it('conta cada resultado na métrica certa; só resolvidas, expiradas e reagendadas contam como avanço', async () => {
    const { worker, metrics } = setup({
      a: { type: 'resolved', transactionId: 'a', status: WagerTransactionStatus.Processed },
      b: { type: 'resolved', transactionId: 'b', status: WagerTransactionStatus.Rejected },
      c: { type: 'expired', transactionId: 'c' },
      d: { type: 'rescheduled', transactionId: 'd', nextReferenceCheckAt: new Date(0) },
      e: { type: 'skipped', transactionId: 'e', reason: 'wallet_busy' },
      f: { type: 'skipped', transactionId: 'f', reason: 'not_due' },
      g: { type: 'transient', transactionId: 'g', reason: 'lock_timeout' },
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
    const { worker, metrics, lines, resolved } = setup({
      a: new TypeError('bug'),
      b: { type: 'resolved', transactionId: 'b', status: WagerTransactionStatus.Processed },
    });
    expect(await worker.runOnce()).toEqual({ candidates: 2, progressed: 1 });
    expect(resolved).toEqual(['a', 'b']);
    expect(await total(metrics.pendingReferenceSkipped, { reason: 'error' })).toBe(1);
    expect(lines.find((line) => line.event === 'pending_reference_failed')).toMatchObject({
      transactionId: 'a',
      walletId: 'w-a',
      errorName: 'TypeError',
    });
  });

  it('keepGoing false → para antes da próxima candidata', async () => {
    const { worker, resolved } = setup({
      a: { type: 'expired', transactionId: 'a' },
      b: { type: 'expired', transactionId: 'b' },
    });
    let calls = 0;
    expect(await worker.runOnce(() => calls++ === 0)).toEqual({ candidates: 2, progressed: 1 });
    expect(resolved).toEqual(['a']);
  });
});

describe('WagerSettlement', () => {
  it.each([0, -1, 1.5])('TTL %p é rejeitado', (ttl) => {
    expect(() => new WagerSettlement({ uuid: () => 'x' }, ttl)).toThrow(RangeError);
  });
});
