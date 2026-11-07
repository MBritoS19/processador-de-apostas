import { InvalidMoneyError } from '../../domain/errors';
import { WalletBalanceChanged } from '../../domain/events/wallet-balance-changed';
import { Money, type MoneyProps } from '../../domain/money';
import { OutboxMessage } from '../../domain/outbox-message';
import {
  INTERNAL_PROVIDER_ID,
  OPENING_KEY_PREFIX,
  WagerTransaction,
  WagerTransactionKind,
} from '../../domain/wager-transaction';
import { Wallet } from '../../domain/wallet';
import type { Clock } from '../ports/clock';
import type { IdGenerator } from '../ports/id-generator';
import {
  TransientPersistenceError,
  UniqueViolationError,
  type TransientPersistenceReason,
  type WagerUnitOfWork,
} from '../ports/wager-unit-of-work';
import { wagerPayloadHash } from '../wagering/payload-hash';
import { textProblem } from '../wagering/process-wager-transaction';

/** Corpo do POST /wallets como chega da borda: ainda não validado. */
export interface OpenWalletCommand {
  playerId: unknown;
  initialBalance: unknown;
  correlationId: string;
}

export type OpenWalletResult =
  | { type: 'Opened'; wallet: { id: string; playerId: string; balance: MoneyProps; version: number } }
  | { type: 'InvalidInput'; reason: string }
  /** `existingWalletId` ausente só se a wallet sumir entre o conflito e a releitura (wallets não são apagadas). */
  | { type: 'WalletAlreadyExists'; existingWalletId?: string }
  | { type: 'TransientFailure'; reason: TransientPersistenceReason };

/**
 * Abre uma wallet (CHALLENGE §9). Saldo inicial positivo gera, na mesma transação SQL, a
 * transação interna OPENING (PROCESSED), o lançamento CREDIT e o `WalletBalanceChanged` na outbox.
 * OPENING é interna: não gera `WagerTransactionProcessed`.
 */
export class OpenWallet {
  constructor(
    private readonly unitOfWork: WagerUnitOfWork,
    private readonly clock: Clock,
    private readonly ids: IdGenerator,
  ) {}

  async execute(command: OpenWalletCommand): Promise<OpenWalletResult> {
    const problem = textProblem('playerId', command.playerId);
    if (problem) return { type: 'InvalidInput', reason: problem };
    if (command.initialBalance === null || typeof command.initialBalance !== 'object') {
      return { type: 'InvalidInput', reason: 'initialBalance é obrigatório' };
    }
    const playerId = command.playerId as string;
    let initialBalance: Money;
    try {
      initialBalance = Money.from(command.initialBalance as MoneyProps);
    } catch (error) {
      if (error instanceof InvalidMoneyError) return { type: 'InvalidInput', reason: error.message };
      throw error;
    }
    if (initialBalance.isNegative()) return { type: 'InvalidInput', reason: 'saldo inicial não pode ser negativo' };

    const at = this.clock.now();
    const walletId = this.ids.uuid();
    const openingTransactionId = this.ids.uuid();
    const { wallet, openingEntry } = Wallet.open({
      id: walletId,
      playerId,
      initialBalance,
      openingTransactionId,
      openingEntryId: this.ids.uuid(),
      at,
    });

    try {
      await this.unitOfWork.run(async (repository) => {
        await repository.insertWallet(wallet);
        if (openingEntry === undefined) return;
        const key = `${OPENING_KEY_PREFIX}${walletId}`;
        const fields = {
          providerId: INTERNAL_PROVIDER_ID,
          externalTransactionId: key,
          playerId,
          walletId,
          roundId: 'opening',
          gameId: 'system',
          kind: WagerTransactionKind.Opening,
          money: initialBalance,
        };
        const opening = WagerTransaction.opening({
          ...fields,
          id: openingTransactionId,
          idempotencyKey: key,
          payloadHash: wagerPayloadHash(fields),
          createdAt: at,
          correlationId: command.correlationId,
        });
        await repository.insertTransaction(opening);
        await repository.insertLedgerEntry(openingEntry);
        const event = WalletBalanceChanged.from(wallet, openingEntry, {
          eventId: this.ids.uuid(),
          correlationId: command.correlationId,
          causationId: opening.id,
          occurredAt: at,
        });
        await repository.insertOutbox([OutboxMessage.enqueue(event)]);
      });
    } catch (error) {
      if (error instanceof UniqueViolationError && error.kind === 'wallet') {
        return this.alreadyExists(playerId, initialBalance.currency);
      }
      if (error instanceof TransientPersistenceError) return { type: 'TransientFailure', reason: error.reason };
      throw error;
    }

    return {
      type: 'Opened',
      wallet: { id: wallet.id, playerId, balance: wallet.balance.toJSON(), version: wallet.version },
    };
  }

  private async alreadyExists(playerId: string, currency: string): Promise<OpenWalletResult> {
    try {
      const existingWalletId = await this.unitOfWork.run((repository) =>
        repository.findWalletIdByPlayer(playerId, currency),
      );
      return existingWalletId === undefined ? { type: 'WalletAlreadyExists' } : { type: 'WalletAlreadyExists', existingWalletId };
    } catch (error) {
      if (error instanceof TransientPersistenceError) return { type: 'TransientFailure', reason: error.reason };
      throw error;
    }
  }
}
