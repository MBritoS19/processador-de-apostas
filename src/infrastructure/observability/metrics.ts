import { Counter, Gauge, Histogram, Registry } from 'prom-client';

/**
 * Métricas Prometheus num registry próprio (nunca o default do prom-client). Labels só com
 * valores de conjunto fechado (`status`, `kind`, `failure_code`, `reason`, ...). Ids nunca são labels.
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
    help: 'Conflitos de lock da wallet, por reason (lock_timeout, deadlock, version_conflict).',
    labelNames: ['reason'] as const,
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

  // Consumidor SQS e outbox publisher.
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
  readonly consumerDbUnavailable = new Gauge({
    name: 'wagering_consumer_db_unavailable',
    help: '1 enquanto o consumidor SQS está no modo "banco fora" (sem receber, sondando o Postgres); 0 caso contrário.',
    registers: [this.registry],
  });
  readonly outboxLag = new Gauge({
    name: 'wagering_outbox_lag_seconds',
    help: 'Idade, em segundos, do evento mais antigo ainda não publicado da outbox.',
    registers: [this.registry],
  });

  // Outbox publisher.
  readonly outboxPublished = new Counter({
    name: 'wagering_outbox_published_total',
    help: 'Eventos da outbox publicados e marcados como publicados (commit).',
    registers: [this.registry],
  });
  readonly outboxPublishFailures = new Counter({
    name: 'wagering_outbox_publish_failures_total',
    help: 'Falhas de publicação: scope=batch (a chamada inteira falhou) ou entry (entrada recusada no lote).',
    labelNames: ['scope'] as const,
    registers: [this.registry],
  });
  readonly outboxRetries = new Counter({
    name: 'wagering_outbox_retries_total',
    help: 'Eventos da outbox reagendados com backoff após falha de publicação.',
    registers: [this.registry],
  });
  readonly outboxStuck = new Gauge({
    name: 'wagering_outbox_stuck_events',
    help: 'Eventos pendentes com tentativas acima do limite (OUTBOX_STUCK_ATTEMPTS); bloqueiam o agregado.',
    registers: [this.registry],
  });

  // Worker de referências pendentes.
  readonly pendingReferences = new Gauge({
    name: 'wagering_pending_references',
    help: 'Transações em PENDING_REFERENCE (medido em intervalo fixo pelo worker).',
    registers: [this.registry],
  });
  readonly pendingReferenceResolved = new Counter({
    name: 'wagering_pending_reference_resolved_total',
    help: 'Pendentes resolvidas com a referência encontrada, por status final (PROCESSED ou REJECTED).',
    labelNames: ['status'] as const,
    registers: [this.registry],
  });
  readonly pendingReferenceExpired = new Counter({
    name: 'wagering_pending_reference_expired_total',
    help: 'Pendentes rejeitadas com REFERENCE_NOT_FOUND por prazo esgotado.',
    registers: [this.registry],
  });
  readonly pendingReferenceRescheduled = new Counter({
    name: 'wagering_pending_reference_rescheduled_total',
    help: 'Novas tentativas agendadas (referência ainda ausente ou não resolvida).',
    registers: [this.registry],
  });
  readonly pendingReferenceFailed = new Counter({
    name: 'wagering_pending_reference_failed_total',
    help: 'Pendentes encerradas como FAILED (INFRASTRUCTURE_FAILURE) após erros inesperados seguidos.',
    registers: [this.registry],
  });
  readonly pendingReferenceSkipped = new Counter({
    name: 'wagering_pending_reference_skipped_total',
    help: 'Candidatas puladas: wallet_busy, not_due (tratada por outra instância), transient ou error.',
    labelNames: ['reason'] as const,
    registers: [this.registry],
  });
}
