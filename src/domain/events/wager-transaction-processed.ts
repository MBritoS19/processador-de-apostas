import { InvalidWagerTransactionError } from '../errors';
import type { MoneyProps } from '../money';
import type { Wallet } from '../wallet';
import { WagerTransactionStatus, type WagerTransaction } from '../wager-transaction';
import { IntegrationEvent, type EventContext } from './integration-event';
import { wagerTransactionData, type WagerTransactionData } from './wager-transaction-data';

export interface WagerTransactionProcessedData extends WagerTransactionData {
  referenceTransactionId: string | null;
  /** Saldo observado logo após o processamento (inclusive LOSS, que não o altera). */
  balance: MoneyProps;
  walletVersion: number;
  processedAt: string;
}

/** Qualquer transação aplicada, inclusive LOSS. */
export class WagerTransactionProcessed extends IntegrationEvent<WagerTransactionProcessedData> {
  override readonly eventType = 'WagerTransactionProcessed';
  override readonly version = 1;

  static from(tx: WagerTransaction, wallet: Wallet, ctx: EventContext): WagerTransactionProcessed {
    const common = wagerTransactionData(tx, WagerTransactionStatus.Processed, 'WagerTransactionProcessed');
    if (tx.walletId !== wallet.id || tx.processedAt === undefined) {
      throw new InvalidWagerTransactionError('evento exige a wallet da transação e processedAt');
    }
    return new WagerTransactionProcessed({
      ...ctx,
      aggregateId: tx.id,
      data: {
        ...common,
        referenceTransactionId: tx.referenceTransactionId ?? null,
        balance: wallet.balance.toJSON(),
        walletVersion: wallet.version,
        processedAt: tx.processedAt.toISOString(),
      },
    });
  }
}
