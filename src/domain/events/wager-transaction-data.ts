import { InvalidTransactionStateError } from '../errors';
import type { MoneyProps } from '../money';
import type { WagerTransaction, WagerTransactionKind, WagerTransactionStatus } from '../wager-transaction';

/** Campos comuns aos eventos de transação. */
export interface WagerTransactionData {
  transactionId: string;
  providerId: string;
  externalTransactionId: string;
  walletId: string;
  playerId: string;
  roundId: string;
  gameId: string;
  kind: WagerTransactionKind;
  money: MoneyProps;
}

export function wagerTransactionData(
  tx: WagerTransaction,
  expected: WagerTransactionStatus,
  eventType: string,
): WagerTransactionData {
  if (tx.status !== expected) {
    throw new InvalidTransactionStateError(tx.id, tx.status, eventType);
  }
  return {
    transactionId: tx.id,
    providerId: tx.providerId,
    externalTransactionId: tx.externalTransactionId,
    walletId: tx.walletId,
    playerId: tx.playerId,
    roundId: tx.roundId,
    gameId: tx.gameId,
    kind: tx.kind,
    money: tx.money.toJSON(),
  };
}
