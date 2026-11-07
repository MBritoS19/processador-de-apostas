import { InvalidWagerTransactionError } from '../errors';
import type { FailureCode } from '../failure-code';
import { WagerTransactionStatus, type WagerTransaction } from '../wager-transaction';
import { IntegrationEvent, type EventContext } from './integration-event';
import { wagerTransactionData, type WagerTransactionData } from './wager-transaction-data';

export interface WagerTransactionRejectedData extends WagerTransactionData {
  failureCode: FailureCode;
}

/** Transação rejeitada por regra de negócio. */
export class WagerTransactionRejected extends IntegrationEvent<WagerTransactionRejectedData> {
  override readonly eventType = 'WagerTransactionRejected';
  override readonly version = 1;

  static from(tx: WagerTransaction, ctx: EventContext): WagerTransactionRejected {
    const common = wagerTransactionData(tx, WagerTransactionStatus.Rejected, 'WagerTransactionRejected');
    if (tx.failureCode === undefined) {
      throw new InvalidWagerTransactionError('transação rejeitada sem failureCode');
    }
    return new WagerTransactionRejected({
      ...ctx,
      aggregateId: tx.id,
      data: { ...common, failureCode: tx.failureCode },
    });
  }
}
