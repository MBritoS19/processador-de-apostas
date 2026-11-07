import { Money } from '../../../src/domain/money';
import {
  WagerTransaction,
  WagerTransactionKind,
  type CreateWagerTransactionProps,
} from '../../../src/domain/wager-transaction';

export const T0 = new Date('2026-11-07T12:00:00.000Z');

export const brl = (amount: string): Money => Money.from({ amount, currency: 'BRL' });

export function newTransaction(overrides: Partial<CreateWagerTransactionProps> = {}): WagerTransaction {
  return WagerTransaction.create({
    id: 'tx-1',
    providerId: 'provider-1',
    externalTransactionId: 'ext-1',
    idempotencyKey: 'key-1',
    payloadHash: 'hash-1',
    walletId: 'wallet-1',
    playerId: 'player-1',
    roundId: 'round-1',
    gameId: 'game-1',
    kind: WagerTransactionKind.Bet,
    money: brl('10.00'),
    createdAt: T0,
    ...overrides,
  });
}
