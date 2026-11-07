import type {
  ProcessWagerTransaction,
  ProcessWagerTransactionCommand,
  ProcessWagerTransactionResult,
  WagerTransactionPayload,
} from '../../application/wagering/process-wager-transaction';
import { WagerTransactionKind } from '../../domain/wager-transaction';
import { rootLogger } from './logger';
import type { ObservabilityMetrics } from './metrics';

const KNOWN_KINDS = new Set<string>(Object.values(WagerTransactionKind));

/**
 * Envolve o use case (não o controller): HTTP e o consumidor SQS passam pelas mesmas métricas
 * e pelo mesmo log. O log carrega só ids e o resultado, nunca o payload financeiro.
 */
export class InstrumentedProcessWagerTransaction {
  private readonly logger = rootLogger.child({ name: 'ProcessWagerTransaction' });

  constructor(
    private readonly delegate: Pick<ProcessWagerTransaction, 'execute'>,
    private readonly metrics: ObservabilityMetrics,
  ) {}

  async execute(command: ProcessWagerTransactionCommand): Promise<ProcessWagerTransactionResult> {
    const startedAt = performance.now();
    // O payload ainda não foi validado (pode até ser null vindo da fila).
    const payload: Partial<WagerTransactionPayload> = command.payload ?? {};
    // Label só com kind conhecido: o valor cru vem do cliente e explodiria a cardinalidade.
    const kind = typeof payload.kind === 'string' && KNOWN_KINDS.has(payload.kind) ? payload.kind : 'UNKNOWN';
    const ids = {
      correlationId: command.correlationId,
      providerId: textValue(payload.providerId),
      walletId: textValue(payload.walletId),
    };

    let result: ProcessWagerTransactionResult;
    try {
      result = await this.delegate.execute(command);
    } catch (error) {
      const labels = { status: 'ERROR', kind, failure_code: 'NONE' };
      this.metrics.transactions.inc(labels);
      this.metrics.processingLatency.observe(labels, (performance.now() - startedAt) / 1000);
      this.logger.error(
        { ...ids, event: 'wager_transaction_error', errorName: error instanceof Error ? error.name : typeof error },
        'wager transaction failed',
      );
      throw error;
    }

    const labels = { status: statusLabel(result), kind, failure_code: result.type === 'Rejected' ? result.failureCode : 'NONE' };
    this.metrics.transactions.inc(labels);
    this.metrics.processingLatency.observe(labels, (performance.now() - startedAt) / 1000);
    if (result.type === 'IdempotencyConflict') this.metrics.idempotencyConflicts.inc({ kind });
    else if ('idempotentReplay' in result && result.idempotentReplay) this.metrics.replays.inc({ kind });

    this.logger.info(
      {
        ...ids,
        ...('transactionId' in result ? { transactionId: result.transactionId } : {}),
        status: labels.status,
        event: 'wager_transaction_processed',
      },
      'wager transaction processed',
    );
    return result;
  }
}

function statusLabel(result: ProcessWagerTransactionResult): string {
  switch (result.type) {
    case 'Processed':
    case 'Rejected':
    case 'PendingReference':
      return result.status;
    case 'InvalidInput':
      return 'INVALID_INPUT';
    case 'IdempotencyConflict':
      return 'IDEMPOTENCY_CONFLICT';
    case 'TransientFailure':
      return 'TRANSIENT_FAILURE';
  }
}

/** Ids no log só quando são texto de tamanho razoável (o payload ainda não foi validado). */
function textValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.length <= 256 ? value : undefined;
}
