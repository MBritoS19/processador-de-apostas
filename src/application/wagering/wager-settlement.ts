import { InsufficientBalanceError, InvalidMoneyError, InvalidWagerTransactionError } from '../../domain/errors';
import type { EventContext } from '../../domain/events/integration-event';
import { WagerTransactionPendingReference } from '../../domain/events/wager-transaction-pending-reference';
import { WagerTransactionProcessed } from '../../domain/events/wager-transaction-processed';
import { WagerTransactionRejected } from '../../domain/events/wager-transaction-rejected';
import { WalletBalanceChanged } from '../../domain/events/wallet-balance-changed';
import { FailureCode } from '../../domain/failure-code';
import { OutboxMessage } from '../../domain/outbox-message';
import { addMs } from '../../domain/backoff';
import { JournalEntry } from '../../domain/journal-entry';
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

/**
 * `insert`: transação nova (entrada HTTP/SQS). `update`: reprocessamento de uma PENDING_REFERENCE
 * já gravada (worker); nova tentativa sem resolução não gera evento.
 */
export type SettlementMode = 'insert' | 'update';

/** `expired`: a tentativa esgotou o prazo da referência (REJECTED com REFERENCE_NOT_FOUND). */
export interface SettlementOutcome {
  expired: boolean;
}

type ReferenceCheck = { type: 'ok'; reference: WagerTransaction } | { type: 'pending' } | { type: 'reject'; code: FailureCode };

/**
 * Regras de negócio (CHALLENGE §7) + gravação de transação, saldo, ledger e outbox, tudo dentro
 * da transação SQL do chamador, que já segura o lock da wallet. Fonte única das regras.
 */
export class WagerSettlement {
  constructor(
    private readonly ids: IdGenerator,
    /**
     * Prazo para a referência aparecer, contado do `createdAt` da transação dependente (PENDING_REFERENCE_TTL_MS).
     * Esgotado: REJECTED com REFERENCE_NOT_FOUND (ARCHITECTURE.md → "Worker de referências pendentes").
     */
    private readonly referenceTtlMs: number,
  ) {
    if (!Number.isInteger(referenceTtlMs) || referenceTtlMs <= 0) {
      throw new RangeError('referenceTtlMs deve ser um inteiro positivo');
    }
  }

  /**
   * Aplica as regras e grava tudo. `tx` sai no estado final da tentativa. Se `tx` virou terminal,
   * antecipa as pendentes da mesma wallet que a referenciam (caminho rápido; quem resolve é o worker).
   */
  async settle(
    repository: WagerProcessingRepository,
    tx: WagerTransaction,
    wallet: Wallet | undefined,
    context: SettlementContext,
    mode: SettlementMode,
  ): Promise<SettlementOutcome> {
    const expectedVersion = wallet?.version;
    const entry = await this.apply(repository, tx, wallet, context.now);

    if (mode === 'insert') await repository.insertTransaction(tx);
    else await repository.updatePendingTransaction(tx);
    if (entry !== undefined && wallet !== undefined && expectedVersion !== undefined) {
      await repository.updateWallet(wallet, expectedVersion);
      await repository.insertLedgerEntry(entry);
      // Diário de partidas dobradas na mesma transação SQL; se ele falhar, nada é gravado.
      await repository.insertJournalEntry(JournalEntry.forTransaction(this.ids.uuid(), tx, entry));
    }
    const retried = mode === 'update' && tx.status === WagerTransactionStatus.PendingReference;
    if (!retried) await repository.insertOutbox(this.events(tx, wallet, entry, context));
    // Só com a wallet travada: o UPDATE toca apenas pendentes dessa wallet (ordem de locks). Uma
    // rejeição sem wallet do player nunca serve de referência, então não há o que antecipar.
    if (tx.isTerminal() && wallet !== undefined) await this.expedite(repository, tx, context.now);
    return { expired: tx.failureCode === FailureCode.ReferenceNotFound };
  }

  /**
   * Encerra uma PENDING_REFERENCE como FAILED com INFRASTRUCTURE_FAILURE (erro inesperado repetido
   * no worker), com WagerTransactionRejected na outbox. O chamador segura o lock da wallet e da transação.
   */
  async fail(repository: WagerProcessingRepository, tx: WagerTransaction, context: SettlementContext): Promise<void> {
    tx.fail(FailureCode.InfrastructureFailure);
    await repository.updatePendingTransaction(tx);
    await repository.insertOutbox([
      OutboxMessage.enqueue(
        WagerTransactionRejected.from(tx, {
          eventId: this.ids.uuid(),
          correlationId: context.correlationId,
          causationId: context.causationId,
          occurredAt: context.now,
        }),
      ),
    ]);
    await this.expedite(repository, tx, context.now);
  }

  private async expedite(repository: WagerProcessingRepository, tx: WagerTransaction, now: Date): Promise<void> {
    await repository.expediteAwaitingReference(tx.providerId, tx.externalTransactionId, tx.walletId, now);
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
      if (check.type === 'pending') {
        // TTL de relógio a partir do createdAt, e não contagem de tentativas: o caminho rápido e o backoff
        // consomem tentativas de forma imprevisível e expirariam cedo cadeias que ainda andam. Esgotado,
        // REFERENCE_NOT_FOUND (CHALLENGE §7.1; ARCHITECTURE.md → "Worker de referências pendentes").
        const deadline = addMs(tx.createdAt, this.referenceTtlMs);
        if (now >= deadline) return void tx.reject(FailureCode.ReferenceNotFound, wallet.balance);
        return void tx.markPendingReference(now, deadline);
      }
      if (check.type === 'reject') return void tx.reject(check.code, wallet.balance);
      reference = check.reference;
      // Uma reversão (REFUND ou ROLLBACK) por BET, não uma de cada tipo: REFUND + ROLLBACK da mesma BET
      // devolveria a aposta duas vezes. Vale também para WIN/LOSS sobre BET estornada. A garantia sob
      // concorrência é o índice ux_wager_tx_one_reversal; esta checagem só produz o failureCode
      // (ARCHITECTURE.md → "Regras de negócio").
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
