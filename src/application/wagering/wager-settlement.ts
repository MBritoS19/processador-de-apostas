import { InsufficientBalanceError, InvalidMoneyError, InvalidWagerTransactionError } from '../../domain/errors';
import type { EventContext } from '../../domain/events/integration-event';
import { WagerTransactionPendingReference } from '../../domain/events/wager-transaction-pending-reference';
import { WagerTransactionProcessed } from '../../domain/events/wager-transaction-processed';
import { WagerTransactionRejected } from '../../domain/events/wager-transaction-rejected';
import { WalletBalanceChanged } from '../../domain/events/wallet-balance-changed';
import { FailureCode } from '../../domain/failure-code';
import { OutboxMessage } from '../../domain/outbox-message';
import { WagerTransactionStatus, type WagerTransaction } from '../../domain/wager-transaction';
import type { Wallet } from '../../domain/wallet';
import { LedgerDirection, type WalletLedgerEntry } from '../../domain/wallet-ledger-entry';
import type { IdGenerator } from '../ports/id-generator';
import type { WagerProcessingRepository } from '../ports/wager-unit-of-work';

/** Contexto dos eventos gravados na outbox por um settlement. */
export interface SettlementContext {
  now: Date;
  correlationId: string;
  /** Causa dos eventos de estado; o WalletBalanceChanged é causado pelo WagerTransactionProcessed. */
  causationId: string;
}

type ReferenceCheck = { type: 'ok'; reference: WagerTransaction } | { type: 'pending' } | { type: 'reject'; code: FailureCode };

/**
 * Regras de negócio (CHALLENGE §7) + gravação de transação, saldo, ledger e outbox, tudo dentro
 * da transação SQL do chamador, que já segura o lock da wallet. Fonte única das regras.
 */
export class WagerSettlement {
  constructor(private readonly ids: IdGenerator) {}

  /** Aplica as regras a uma transação nova (PENDING) e grava tudo. `tx` sai no estado final da tentativa. */
  async settle(
    repository: WagerProcessingRepository,
    tx: WagerTransaction,
    wallet: Wallet | undefined,
    context: SettlementContext,
  ): Promise<void> {
    const expectedVersion = wallet?.version;
    const entry = await this.apply(repository, tx, wallet, context.now);

    await repository.insertTransaction(tx);
    if (entry !== undefined && wallet !== undefined && expectedVersion !== undefined) {
      await repository.updateWallet(wallet, expectedVersion);
      await repository.insertLedgerEntry(entry);
    }
    await repository.insertOutbox(this.events(tx, wallet, entry, context));
  }

  /** Aplica as regras de negócio, mudando `tx` (e `wallet`, se houver lançamento). */
  private async apply(
    repository: WagerProcessingRepository,
    tx: WagerTransaction,
    wallet: Wallet | undefined,
    now: Date,
  ): Promise<WalletLedgerEntry | undefined> {
    // Rejeições no nível da wallet não devolvem saldo: a wallet pode não ser do player.
    if (wallet === undefined) {
      const exists = await repository.walletExists(tx.walletId);
      return void tx.reject(exists ? FailureCode.WalletPlayerMismatch : FailureCode.WalletNotFound);
    }
    if (wallet.currency !== tx.money.currency) return void tx.reject(FailureCode.CurrencyMismatch);

    let reference: WagerTransaction | undefined;
    if (tx.referenceExternalTransactionId !== undefined) {
      const found = await repository.findByExternalId(tx.providerId, tx.referenceExternalTransactionId);
      const check = checkReference(tx, found);
      if (check.type === 'pending') return void tx.markPendingReference(now);
      if (check.type === 'reject') return void tx.reject(check.code, wallet.balance);
      reference = check.reference;
      // Vale para reversões (uma no total) e para WIN/LOSS: liquidar uma BET já estornada creditaria duas vezes.
      if (await repository.hasProcessedReversal(reference.id)) {
        return void tx.reject(FailureCode.ReferenceAlreadyReversed, wallet.balance);
      }
    }

    if (!tx.affectsBalance()) return void tx.markProcessed(reference?.id, now, wallet.balance);

    const movement = { entryId: this.ids.uuid(), transactionId: tx.id, money: tx.money, at: now };
    let entry: WalletLedgerEntry;
    try {
      entry =
        tx.ledgerDirectionFor(reference) === LedgerDirection.Debit ? wallet.debit(movement) : wallet.credit(movement);
    } catch (error) {
      if (error instanceof InsufficientBalanceError) {
        const code = tx.isReversal() ? FailureCode.ReversalWouldOverdraw : FailureCode.InsufficientBalance;
        return void tx.reject(code, wallet.balance);
      }
      // Só o crédito pode passar do limite do numeric(20,2); a wallet fica intacta (Wallet.apply).
      if (error instanceof InvalidMoneyError) return void tx.reject(FailureCode.BalanceLimitExceeded, wallet.balance);
      throw error;
    }
    tx.markProcessed(reference?.id, now, wallet.balance);
    return entry;
  }

  /** Um evento de estado por transação + WalletBalanceChanged quando há lançamento. */
  private events(
    tx: WagerTransaction,
    wallet: Wallet | undefined,
    entry: WalletLedgerEntry | undefined,
    { now, correlationId, causationId }: SettlementContext,
  ): OutboxMessage[] {
    const context = (cause: string): EventContext => ({
      eventId: this.ids.uuid(),
      correlationId,
      causationId: cause,
      occurredAt: now,
    });

    switch (tx.status) {
      case WagerTransactionStatus.Processed: {
        if (wallet === undefined) throw new InvalidWagerTransactionError('transação processada sem wallet');
        const processed = WagerTransactionProcessed.from(tx, wallet, context(causationId));
        const messages = [OutboxMessage.enqueue(processed)];
        if (entry !== undefined) {
          messages.push(OutboxMessage.enqueue(WalletBalanceChanged.from(wallet, entry, context(processed.eventId))));
        }
        return messages;
      }
      case WagerTransactionStatus.Rejected:
        return [OutboxMessage.enqueue(WagerTransactionRejected.from(tx, context(causationId)))];
      case WagerTransactionStatus.PendingReference:
        return [OutboxMessage.enqueue(WagerTransactionPendingReference.from(tx, context(causationId)))];
      default:
        throw new InvalidWagerTransactionError(`estado inesperado após o processamento: ${tx.status}`);
    }
  }
}

/** Ordem: kind → wallet → player → rodada → moeda → status da referência → valor (reversões). */
function checkReference(tx: WagerTransaction, reference: WagerTransaction | undefined): ReferenceCheck {
  if (reference === undefined) return { type: 'pending' };
  const reject = (code: FailureCode): ReferenceCheck => ({ type: 'reject', code });

  if (!tx.canReference(reference)) return reject(FailureCode.InvalidReferenceKind);
  if (reference.walletId !== tx.walletId) return reject(FailureCode.ReferenceWalletMismatch);
  if (reference.playerId !== tx.playerId) return reject(FailureCode.ReferencePlayerMismatch);
  if (reference.roundId !== tx.roundId) return reject(FailureCode.ReferenceRoundMismatch);
  if (reference.money.currency !== tx.money.currency) return reject(FailureCode.CurrencyMismatch);
  if (reference.status === WagerTransactionStatus.Pending || reference.status === WagerTransactionStatus.PendingReference) {
    return { type: 'pending' };
  }
  if (reference.status !== WagerTransactionStatus.Processed) return reject(FailureCode.ReferenceNotProcessed);
  if (tx.isReversal() && !reference.money.equals(tx.money)) return reject(FailureCode.AmountMismatch);
  return { type: 'ok', reference };
}
