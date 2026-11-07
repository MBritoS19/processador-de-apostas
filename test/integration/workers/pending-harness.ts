import type { MikroORM } from '@mikro-orm/postgresql';
import type { Logger } from 'pino';
import type { Clock } from '../../../src/application/ports/clock';
import { ProcessWagerTransaction } from '../../../src/application/wagering/process-wager-transaction';
import { ResolvePendingReferences } from '../../../src/application/wagering/resolve-pending-references';
import { WagerSettlement } from '../../../src/application/wagering/wager-settlement';
import { LoggingLockConflictTelemetry } from '../../../src/infrastructure/observability/lock-conflict-telemetry';
import { ObservabilityMetrics } from '../../../src/infrastructure/observability/metrics';
import { MikroOrmWagerUnitOfWork } from '../../../src/infrastructure/persistence/mikro-orm-wager-unit-of-work';
import { randomIdGenerator } from '../../../src/infrastructure/system-adapters';
import {
  PendingReferenceWorker,
  type PendingReferenceWorkerOptions,
} from '../../../src/interfaces/workers/pending-reference-worker';
import { captureLogger } from './outbox-harness';

export const TEST_WORKER_OPTIONS: PendingReferenceWorkerOptions = {
  batchSize: 10,
  pollIntervalMs: 20,
  gaugeIntervalMs: 50,
  shutdownTimeoutMs: 5_000,
};

/** Use case e worker sobre o mesmo relógio e o mesmo settlement (mesmo TTL), como na aplicação. */
export function buildPendingFixture(
  orm: MikroORM,
  clock: Clock,
  overrides: { ttlMs?: number; options?: Partial<PendingReferenceWorkerOptions>; logger?: Logger } = {},
) {
  const settlement = new WagerSettlement(randomIdGenerator, overrides.ttlMs);
  const unitOfWork = new MikroOrmWagerUnitOfWork(orm.em);
  const telemetry = new LoggingLockConflictTelemetry(() => undefined);
  const useCase = new ProcessWagerTransaction(unitOfWork, clock, randomIdGenerator, telemetry, settlement);
  const resolver = new ResolvePendingReferences(unitOfWork, clock, settlement);
  const metrics = new ObservabilityMetrics();
  const log = captureLogger();
  const worker = new PendingReferenceWorker(
    resolver,
    metrics,
    { ...TEST_WORKER_OPTIONS, ...overrides.options },
    overrides.logger ?? log.logger,
  );
  return { useCase, resolver, worker, metrics, telemetry, logs: log.lines };
}

export interface TxRow {
  id: string;
  status: string;
  failure_code: string | null;
  observed_balance: string | null;
  reference_attempts: number;
  next_reference_check_at: Date | null;
  reference_transaction_id: string | null;
  correlation_id: string | null;
}

export async function txByExternal(orm: MikroORM, externalTransactionId: string, providerId = 'provider-a'): Promise<TxRow> {
  const [row] = await orm.em
    .fork()
    .getKnex()('wager_transactions')
    .where({ provider_id: providerId, external_transaction_id: externalTransactionId })
    .select('id', 'status', 'failure_code', 'observed_balance', 'reference_attempts', 'next_reference_check_at', 'reference_transaction_id', 'correlation_id');
  if (!row) throw new Error(`transação ${externalTransactionId} não encontrada`);
  // O driver devolve timestamptz como texto.
  const next = (row as { next_reference_check_at: string | null }).next_reference_check_at;
  return { ...(row as TxRow), next_reference_check_at: next === null ? null : new Date(next) };
}

export interface OutboxEvent {
  id: string;
  event_type: string;
  payload: { correlationId: string; causationId?: string; data: Record<string, unknown> };
}

export async function eventsOf(orm: MikroORM, aggregateId: string): Promise<OutboxEvent[]> {
  return (await orm.em
    .fork()
    .getKnex()('outbox_messages')
    .where({ aggregate_id: aggregateId })
    .orderBy('seq')
    .select('id', 'event_type', 'payload')) as OutboxEvent[];
}

/** Lançamentos de uma transação (deve ser 0 ou 1). */
export async function entriesOf(orm: MikroORM, transactionId: string): Promise<number> {
  const [row] = await orm.em.fork().getKnex()('wallet_ledger_entries').where({ transaction_id: transactionId }).count({ n: '*' });
  return Number(row?.n);
}

export async function pendingCount(orm: MikroORM): Promise<number> {
  const [row] = await orm.em.fork().getKnex()('wager_transactions').where({ status: 'PENDING_REFERENCE' }).count({ n: '*' });
  return Number(row?.n);
}

export async function counterTotal(
  counter: { get(): Promise<{ values: Array<{ value: number; labels: Record<string, unknown> }> }> },
  labels: Record<string, string> = {},
): Promise<number> {
  const { values } = await counter.get();
  return values
    .filter((v) => Object.entries(labels).every(([key, value]) => v.labels[key] === value))
    .reduce((sum, v) => sum + v.value, 0);
}
