import { InvalidWagerTransactionError } from '../errors';
import { WagerTransactionStatus, type WagerTransaction } from '../wager-transaction';
import { IntegrationEvent, type EventContext } from './integration-event';
import { wagerTransactionData, type WagerTransactionData } from './wager-transaction-data';

export interface WagerTransactionPendingReferenceData extends WagerTransactionData {
  referenceExternalTransactionId: string;
  referenceAttempts: number;
  nextReferenceCheckAt: string;
}

/** Referência ausente: a transação aguarda reprocessamento. */
export class WagerTransactionPendingReference extends IntegrationEvent<WagerTransactionPendingReferenceData> {
  override readonly eventType = 'WagerTransactionPendingReference';
  override readonly version = 1;

  static from(tx: WagerTransaction, ctx: EventContext): WagerTransactionPendingReference {
    const common = wagerTransactionData(tx, WagerTransactionStatus.PendingReference, 'WagerTransactionPendingReference');
    if (tx.referenceExternalTransactionId === undefined || tx.nextReferenceCheckAt === undefined) {
      throw new InvalidWagerTransactionError('transação pendente sem referência ou agendamento');
    }
    return new WagerTransactionPendingReference({
      ...ctx,
      aggregateId: tx.id,
      data: {
        ...common,
        referenceExternalTransactionId: tx.referenceExternalTransactionId,
        referenceAttempts: tx.referenceAttempts,
        nextReferenceCheckAt: tx.nextReferenceCheckAt.toISOString(),
      },
    });
  }
}
