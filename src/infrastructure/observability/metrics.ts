import { Counter, Gauge, Histogram, Registry } from 'prom-client';

/**
 * Métricas Prometheus num registry próprio (nunca o default do prom-client). Labels só com
 * valores de conjunto fechado: `status`, `kind` e `failure_code`. Ids nunca são labels.
 */
export class ObservabilityMetrics {
  readonly registry = new Registry();
  readonly transactions = new Counter({
    name: 'wagering_transactions_total',
    help: 'Resultados do processamento de transações, por status, kind e failure_code.',
    labelNames: ['status', 'kind', 'failure_code'] as const,
    registers: [this.registry],
  });
  readonly replays = new Counter({
    name: 'wagering_idempotent_replays_total',
    help: 'Duplicatas idênticas respondidas como replay idempotente.',
    labelNames: ['kind'] as const,
    registers: [this.registry],
  });
  readonly idempotencyConflicts = new Counter({
    name: 'wagering_idempotency_conflicts_total',
    help: 'Mesma idempotency key (ou id externo) com payload diferente.',
    labelNames: ['kind'] as const,
    registers: [this.registry],
  });
  readonly lockConflicts = new Counter({
    name: 'wagering_lock_conflicts_total',
    help: 'Conflitos de lock da wallet (lock timeout, deadlock, version).',
    registers: [this.registry],
  });
  readonly processingLatency = new Histogram({
    name: 'wagering_processing_duration_seconds',
    help: 'Duração do ProcessWagerTransaction, em segundos.',
    labelNames: ['status', 'kind', 'failure_code'] as const,
    registers: [this.registry],
    buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2, 5],
  });
  readonly reconciliationDivergences = new Counter({
    name: 'wagering_reconciliation_divergences_total',
    help: 'Reconciliações em que o saldo da wallet difere do reconstruído pelo ledger.',
    registers: [this.registry],
  });

  // Declaradas agora; incrementadas nas Fases 5–7.
  readonly retries = new Counter({
    name: 'wagering_retries_total',
    help: 'Novas tentativas de mensagens recebidas ou de processamento.',
    registers: [this.registry],
  });
  readonly dlqMessages = new Counter({
    name: 'wagering_dlq_messages_total',
    help: 'Mensagens enviadas para a dead-letter queue.',
    registers: [this.registry],
  });
  readonly outboxLag = new Gauge({
    name: 'wagering_outbox_lag_seconds',
    help: 'Idade, em segundos, do evento mais antigo ainda não publicado da outbox.',
    registers: [this.registry],
  });
}
