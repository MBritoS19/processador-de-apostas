import { describe, expect, it } from 'bun:test';
import type {
  ProcessWagerTransactionCommand,
  ProcessWagerTransactionResult,
} from '../../../src/application/wagering/process-wager-transaction';
import { InstrumentedProcessWagerTransaction } from '../../../src/infrastructure/observability/instrumented-process-wager-transaction';
import { LoggingLockConflictTelemetry } from '../../../src/infrastructure/observability/lock-conflict-telemetry';
import { ObservabilityMetrics } from '../../../src/infrastructure/observability/metrics';

const command = (payload: unknown): ProcessWagerTransactionCommand =>
  ({ idempotencyKey: 'k', correlationId: 'c', payload }) as ProcessWagerTransactionCommand;

const delegate = (result: ProcessWagerTransactionResult | Error) => ({
  execute: async () => {
    if (result instanceof Error) throw result;
    return result;
  },
});

async function value(metrics: ObservabilityMetrics, name: string, labels: Record<string, string> = {}): Promise<number> {
  const metric = (await metrics.registry.getMetricsAsJSON()).find((m) => m.name === name);
  const match = metric?.values.find((v) => Object.entries(labels).every(([k, l]) => v.labels[k] === l));
  return match?.value ?? 0;
}

describe('InstrumentedProcessWagerTransaction', () => {
  it('kind desconhecido vira UNKNOWN no label (cardinalidade limitada)', async () => {
    const metrics = new ObservabilityMetrics();
    const wrapped = new InstrumentedProcessWagerTransaction(delegate({ type: 'InvalidInput', reason: 'x' }), metrics);
    for (const kind of ['x1', 'x2', 'x3']) await wrapped.execute(command({ kind }));
    const series = (await metrics.registry.getMetricsAsJSON()).find((m) => m.name === 'wagering_transactions_total');
    expect(series?.values).toHaveLength(1);
    expect(series?.values[0]?.labels).toEqual({ status: 'INVALID_INPUT', kind: 'UNKNOWN', failure_code: 'NONE' });
  });

  it('payload nulo não quebra o wrapper', async () => {
    const metrics = new ObservabilityMetrics();
    const wrapped = new InstrumentedProcessWagerTransaction(delegate({ type: 'InvalidInput', reason: 'x' }), metrics);
    expect(await wrapped.execute(command(null))).toEqual({ type: 'InvalidInput', reason: 'x' });
  });

  it('erro lançado pelo use case é medido como ERROR e relançado', async () => {
    const metrics = new ObservabilityMetrics();
    const wrapped = new InstrumentedProcessWagerTransaction(delegate(new Error('bug')), metrics);
    await expect(wrapped.execute(command({ kind: 'BET' }))).rejects.toThrow('bug');
    expect(await value(metrics, 'wagering_transactions_total', { status: 'ERROR', kind: 'BET' })).toBe(1);
  });

  it('replay e conflito vão para contadores separados; rejeição leva failure_code', async () => {
    const metrics = new ObservabilityMetrics();
    const replay = new InstrumentedProcessWagerTransaction(
      delegate({ type: 'Processed', transactionId: 't', status: 'PROCESSED' as never, balance: { amount: '1.00', currency: 'BRL' }, idempotentReplay: true }),
      metrics,
    );
    const conflict = new InstrumentedProcessWagerTransaction(delegate({ type: 'IdempotencyConflict' }), metrics);
    const rejected = new InstrumentedProcessWagerTransaction(
      delegate({ type: 'Rejected', transactionId: 't', status: 'FAILED' as never, failureCode: 'INSUFFICIENT_BALANCE' as never, idempotentReplay: false }),
      metrics,
    );
    await replay.execute(command({ kind: 'BET' }));
    await conflict.execute(command({ kind: 'WIN' }));
    await rejected.execute(command({ kind: 'BET' }));
    expect(await value(metrics, 'wagering_idempotent_replays_total', { kind: 'BET' })).toBe(1);
    expect(await value(metrics, 'wagering_idempotency_conflicts_total', { kind: 'WIN' })).toBe(1);
    expect(await value(metrics, 'wagering_transactions_total', { status: 'FAILED', failure_code: 'INSUFFICIENT_BALANCE' })).toBe(1);
  });
});

describe('LoggingLockConflictTelemetry', () => {
  it('incrementa wagering_lock_conflicts_total', async () => {
    const metrics = new ObservabilityMetrics();
    const telemetry = new LoggingLockConflictTelemetry(() => {}, metrics);
    telemetry.lockConflict({ reason: 'deadlock', walletId: 'w', correlationId: 'c' });
    telemetry.lockConflict({ reason: 'lock_timeout', walletId: 'w', correlationId: 'c' });
    expect(await value(metrics, 'wagering_lock_conflicts_total')).toBe(2);
  });
});

describe('ObservabilityMetrics', () => {
  it('usa registry próprio, isolado entre instâncias', async () => {
    const a = new ObservabilityMetrics();
    const b = new ObservabilityMetrics();
    a.lockConflicts.inc();
    expect(await value(b, 'wagering_lock_conflicts_total')).toBe(0);
  });
});
