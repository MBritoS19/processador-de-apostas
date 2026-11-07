import { InsufficientBalanceError, InvalidMoneyError, InvalidWagerTransactionError } from '../../domain/errors';
import type { EventContext } from '../../domain/events/integration-event';
import { WagerTransactionPendingReference } from '../../domain/events/wager-transaction-pending-reference';
import { WagerTransactionProcessed } from '../../domain/events/wager-transaction-processed';
import { WagerTransactionRejected } from '../../domain/events/wager-transaction-rejected';
import { WalletBalanceChanged } from '../../domain/events/wallet-balance-changed';
import { FailureCode } from '../../domain/failure-code';
import { InboxMessage } from '../../domain/inbox-message';
import { Money, type MoneyProps } from '../../domain/money';
import { OutboxMessage } from '../../domain/outbox-message';
import {
  INTERNAL_PROVIDER_ID,
  OPENING_KEY_PREFIX,
  WagerTransaction,
  WagerTransactionKind,
  WagerTransactionStatus,
} from '../../domain/wager-transaction';
import type { Wallet } from '../../domain/wallet';
import { LedgerDirection, type WalletLedgerEntry } from '../../domain/wallet-ledger-entry';
import type { Clock } from '../ports/clock';
import type { IdGenerator } from '../ports/id-generator';
import type { LockConflictTelemetry } from '../ports/lock-conflict-telemetry';
import {
  TransientPersistenceError,
  UniqueViolationError,
  WalletVersionConflictError,
  type TransientPersistenceReason,
  type UniqueViolationKind,
  type WagerProcessingRepository,
  type WagerUnitOfWork,
} from '../ports/wager-unit-of-work';
import { wagerPayloadHash } from './payload-hash';

/** Payload de negócio como chega da borda (HTTP/SQS): ainda não validado. */
export interface WagerTransactionPayload {
  providerId: unknown;
  externalTransactionId: unknown;
  playerId: unknown;
  walletId: unknown;
  roundId: unknown;
  gameId: unknown;
  kind: unknown;
  money: unknown;
  referenceExternalTransactionId?: unknown;
}

/** Contexto da entrada por SQS (Fase 5): a inbox é gravada na mesma transação. */
export interface InboxContext {
  consumerName: string;
  messageId: string;
  payloadHash: string;
}

/**
 * `payload.providerId` precisa ser, na borda (Fase 4/5), o provider autenticado: o use case
 * confia nele para escopar idempotência e referências.
 */
export interface ProcessWagerTransactionCommand {
  idempotencyKey: string;
  payload: WagerTransactionPayload;
  correlationId: string;
  inbox?: InboxContext | undefined;
}

/**
 * Resultado tipado. As variantes com transação trazem `status`; HTTP/SQS decidem por `type`
 * e, dentro de `Rejected`, por `status` (REJECTED = regra de negócio, FAILED = falha permanente
 * de infraestrutura). Erros lançados (fora da união) são bugs: 500 / sem ack.
 */
export type ProcessWagerTransactionResult =
  | {
      type: 'Processed';
      transactionId: string;
      status: WagerTransactionStatus.Processed;
      balance: MoneyProps;
      idempotentReplay: boolean;
    }
  | {
      type: 'Rejected';
      transactionId: string;
      status: WagerTransactionStatus.Rejected | WagerTransactionStatus.Failed;
      failureCode: FailureCode;
      /** Ausente quando não há wallet do player na moeda da transação. */
      balance?: MoneyProps;
      idempotentReplay: boolean;
    }
  | {
      /** Sem saldo: a transação ainda não foi aplicada. Replay devolve o estado atual (pode já ter resolvido). */
      type: 'PendingReference';
      transactionId: string;
      status: WagerTransactionStatus.PendingReference;
      nextReferenceCheckAt: Date;
      idempotentReplay: boolean;
    }
  | {
      /** `existingTransactionId` ausente quando o conflito é de inbox (mesma mensagem, outra transação). */
      type: 'IdempotencyConflict';
      existingTransactionId?: string;
    }
  | { type: 'InvalidInput'; reason: string }
  | { type: 'TransientFailure'; reason: TransientPersistenceReason | 'version_conflict' };

const SUBMITTABLE_KINDS = new Set<string>([
  WagerTransactionKind.Bet,
  WagerTransactionKind.Win,
  WagerTransactionKind.Loss,
  WagerTransactionKind.Refund,
  WagerTransactionKind.Rollback,
]);
const TEXT_FIELDS = ['providerId', 'externalTransactionId', 'playerId', 'walletId', 'roundId', 'gameId'] as const;
/** Limite dos ids e da key: cabe folgado nos índices btree (o Postgres recusa entradas de ~2.7 KB). */
export const MAX_TEXT_LENGTH = 256;
export const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type ReferenceCheck = { type: 'ok'; reference: WagerTransaction } | { type: 'pending' } | { type: 'reject'; code: FailureCode };

/**
 * Processa uma transação de aposta (BET, WIN, LOSS, REFUND, ROLLBACK) com idempotência
 * persistida e lock pessimista por wallet. Usado pela entrada HTTP (Fase 4) e SQS (Fase 5).
 * Estratégia e SQL exato no ARCHITECTURE.md §12.
 */
export class ProcessWagerTransaction {
  constructor(
    private readonly unitOfWork: WagerUnitOfWork,
    private readonly clock: Clock,
    private readonly ids: IdGenerator,
    private readonly telemetry: LockConflictTelemetry,
  ) {}

  async execute(command: ProcessWagerTransactionCommand): Promise<ProcessWagerTransactionResult> {
    const parsed = this.parse(command);
    if (typeof parsed === 'string') return { type: 'InvalidInput', reason: parsed };

    try {
      return await this.unitOfWork.run((repository) => this.process(repository, parsed, command));
    } catch (error) {
      return this.handleFailure(error, parsed, command);
    }
  }

  /** Validação completa antes de abrir transação: entrada inválida nunca é gravada. */
  private parse(command: ProcessWagerTransactionCommand): WagerTransaction | string {
    const { payload, idempotencyKey } = command;
    if (payload === null || typeof payload !== 'object') return 'payload é obrigatório';
    const keyProblem = textProblem('idempotencyKey', idempotencyKey);
    if (keyProblem) return keyProblem;
    for (const field of TEXT_FIELDS) {
      const problem = textProblem(field, payload[field]);
      if (problem) return problem;
    }
    if (payload.providerId === INTERNAL_PROVIDER_ID) return `providerId "${INTERNAL_PROVIDER_ID}" é reservado`;
    if (idempotencyKey.startsWith(OPENING_KEY_PREFIX)) return `Idempotency-Key com prefixo "${OPENING_KEY_PREFIX}" é reservada`;
    const reference = payload.referenceExternalTransactionId;
    const hasReference = reference !== undefined && reference !== null;
    if (hasReference) {
      const problem = textProblem('referenceExternalTransactionId', reference);
      if (problem) return problem;
      if (reference === payload.externalTransactionId) return 'uma transação não pode referenciar a si mesma';
    }
    const walletId = payload.walletId as string;
    if (!UUID_PATTERN.test(walletId)) return 'walletId deve ser um UUID';
    if (typeof payload.kind !== 'string' || !SUBMITTABLE_KINDS.has(payload.kind)) {
      return 'kind deve ser BET, WIN, LOSS, REFUND ou ROLLBACK';
    }
    const kind = payload.kind as WagerTransactionKind;
    if (kind === WagerTransactionKind.Bet && hasReference) return 'BET não referencia outra transação';
    if (payload.money === null || typeof payload.money !== 'object') return 'money é obrigatório';

    try {
      const money = Money.from(payload.money as MoneyProps);
      const fields = {
        providerId: payload.providerId as string,
        externalTransactionId: payload.externalTransactionId as string,
        playerId: payload.playerId as string,
        walletId: walletId.toLowerCase(),
        roundId: payload.roundId as string,
        gameId: payload.gameId as string,
        kind,
        money,
        referenceExternalTransactionId: hasReference ? (reference as string) : undefined,
      };
      // valor > 0 em BET/WIN/REFUND/ROLLBACK, ≥ 0 em LOSS, e referência obrigatória: validados pelo create.
      return WagerTransaction.create({
        ...fields,
        id: this.ids.uuid(),
        idempotencyKey,
        payloadHash: wagerPayloadHash(fields),
        createdAt: this.clock.now(),
      });
    } catch (error) {
      if (error instanceof InvalidMoneyError || error instanceof InvalidWagerTransactionError) return error.message;
      throw error;
    }
  }

  /**
   * Dentro da transação SQL, nesta ordem: lock da wallet → idempotência → regras → gravações.
   * A idempotência é checada já com o lock: a transação original, se existir, foi gravada
   * por quem segurava o mesmo lock e já está visível (READ COMMITTED).
   */
  private async process(
    repository: WagerProcessingRepository,
    tx: WagerTransaction,
    command: ProcessWagerTransactionCommand,
  ): Promise<ProcessWagerTransactionResult> {
    const wallet = await repository.lockWallet(tx.walletId, tx.playerId);

    const existing = await repository.findByIdempotency(tx.providerId, tx.idempotencyKey, tx.externalTransactionId);
    const decided = decideIdempotency(existing, tx);
    if (decided !== undefined) {
      if (decided.type !== 'IdempotencyConflict' && command.inbox) {
        await repository.insertInbox(this.inboxMessage(command.inbox));
      }
      return decided;
    }

    const now = this.clock.now();
    const expectedVersion = wallet?.version;
    const entry = await this.apply(repository, tx, wallet, now);

    await repository.insertTransaction(tx);
    if (entry !== undefined && wallet !== undefined && expectedVersion !== undefined) {
      await repository.updateWallet(wallet, expectedVersion);
      await repository.insertLedgerEntry(entry);
    }
    await repository.insertOutbox(this.events(tx, wallet, entry, command, now));
    if (command.inbox) await repository.insertInbox(this.inboxMessage(command.inbox));

    return resultOf(tx, false);
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

  /**
   * Um evento de estado por transação + WalletBalanceChanged quando há lançamento.
   * causationId: a mensagem de entrada (inbox) ou a requisição (idempotency key); o
   * WalletBalanceChanged é causado pelo WagerTransactionProcessed.
   */
  private events(
    tx: WagerTransaction,
    wallet: Wallet | undefined,
    entry: WalletLedgerEntry | undefined,
    command: ProcessWagerTransactionCommand,
    now: Date,
  ): OutboxMessage[] {
    const context = (causationId: string): EventContext => ({
      eventId: this.ids.uuid(),
      correlationId: command.correlationId,
      causationId,
      occurredAt: now,
    });
    const cause = command.inbox?.messageId ?? command.idempotencyKey;

    switch (tx.status) {
      case WagerTransactionStatus.Processed: {
        if (wallet === undefined) throw new InvalidWagerTransactionError('transação processada sem wallet');
        const processed = WagerTransactionProcessed.from(tx, wallet, context(cause));
        const messages = [OutboxMessage.enqueue(processed)];
        if (entry !== undefined) {
          messages.push(OutboxMessage.enqueue(WalletBalanceChanged.from(wallet, entry, context(processed.eventId))));
        }
        return messages;
      }
      case WagerTransactionStatus.Rejected:
        return [OutboxMessage.enqueue(WagerTransactionRejected.from(tx, context(cause)))];
      case WagerTransactionStatus.PendingReference:
        return [OutboxMessage.enqueue(WagerTransactionPendingReference.from(tx, context(cause)))];
      default:
        throw new InvalidWagerTransactionError(`estado inesperado após o processamento: ${tx.status}`);
    }
  }

  private inboxMessage(inbox: InboxContext): InboxMessage {
    const now = this.clock.now();
    const message = InboxMessage.receive({ ...inbox, receivedAt: now });
    message.markProcessed(now);
    return message;
  }

  private async handleFailure(
    error: unknown,
    tx: WagerTransaction,
    command: ProcessWagerTransactionCommand,
  ): Promise<ProcessWagerTransactionResult> {
    if (error instanceof UniqueViolationError) return this.resolveDuplicate(tx, error.kind);
    if (error instanceof WalletVersionConflictError) {
      this.telemetry.lockConflict({ reason: 'version_conflict', walletId: tx.walletId, correlationId: command.correlationId });
      return { type: 'TransientFailure', reason: 'version_conflict' };
    }
    if (error instanceof TransientPersistenceError) {
      if (error.reason === 'lock_timeout' || error.reason === 'deadlock') {
        this.telemetry.lockConflict({ reason: error.reason, walletId: tx.walletId, correlationId: command.correlationId });
      }
      return { type: 'TransientFailure', reason: error.reason };
    }
    throw error;
  }

  /**
   * Um INSERT violou a unicidade de idempotência ou da inbox apesar da checagem sob lock
   * (ex.: mesma key com outra walletId, que trava outra linha; ou mensagem reentregue).
   * Após o rollback, relê numa transação nova e devolve replay ou conflito. Nesse caminho a
   * inbox não é gravada. Mensagem de inbox já usada por outra transação → conflito sem id.
   */
  private async resolveDuplicate(tx: WagerTransaction, kind: UniqueViolationKind): Promise<ProcessWagerTransactionResult> {
    let existing: WagerTransaction[];
    try {
      existing = await this.unitOfWork.run((repository) =>
        repository.findByIdempotency(tx.providerId, tx.idempotencyKey, tx.externalTransactionId),
      );
    } catch (error) {
      if (error instanceof TransientPersistenceError) return { type: 'TransientFailure', reason: error.reason };
      throw error;
    }
    const decided = decideIdempotency(existing, tx);
    if (decided !== undefined) return decided;
    if (kind === 'inbox') return { type: 'IdempotencyConflict' };
    // Violação de idempotência sem linha correspondente: transações nunca são apagadas, então é bug.
    throw new Error(`violação de idempotência sem transação correspondente (key ${tx.idempotencyKey})`);
  }
}

/** Texto obrigatório, não vazio, até MAX_TEXT_LENGTH. Devolve o problema ou undefined. */
export function textProblem(field: string, value: unknown): string | undefined {
  if (value === undefined || value === null) return `${field} é obrigatório`;
  if (typeof value !== 'string') return `${field} deve ser texto`;
  if (value.trim() === '') return `${field} não pode ser vazio`;
  if (value.length > MAX_TEXT_LENGTH) return `${field} excede ${MAX_TEXT_LENGTH} caracteres`;
  return undefined;
}

/**
 * Replay só com a mesma key E o mesmo hash. Hash diferente, ou o mesmo
 * externalTransactionId do provider sob outra key, é conflito. `existing` já vem
 * filtrado pelo provider: o id devolvido no conflito nunca é de outro provider.
 */
function decideIdempotency(
  existing: readonly WagerTransaction[],
  incoming: WagerTransaction,
): ProcessWagerTransactionResult | undefined {
  const [first] = existing;
  if (first === undefined) return undefined;
  const byKey = existing.find((tx) => tx.idempotencyKey === incoming.idempotencyKey);
  if (byKey !== undefined && existing.length === 1 && byKey.matchesPayload(incoming.payloadHash)) {
    return resultOf(byKey, true);
  }
  return { type: 'IdempotencyConflict', existingTransactionId: (byKey ?? first).id };
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

/** Resultado a partir do estado persistido: o replay devolve exatamente o original. */
function resultOf(tx: WagerTransaction, idempotentReplay: boolean): ProcessWagerTransactionResult {
  switch (tx.status) {
    case WagerTransactionStatus.Processed: {
      if (tx.observedBalance === undefined) throw new InvalidWagerTransactionError('PROCESSED sem saldo observado');
      return {
        type: 'Processed',
        transactionId: tx.id,
        status: tx.status,
        balance: tx.observedBalance.toJSON(),
        idempotentReplay,
      };
    }
    case WagerTransactionStatus.Rejected:
    case WagerTransactionStatus.Failed: {
      if (tx.failureCode === undefined) throw new InvalidWagerTransactionError(`${tx.status} sem failureCode`);
      return {
        type: 'Rejected',
        transactionId: tx.id,
        status: tx.status,
        failureCode: tx.failureCode,
        ...(tx.observedBalance !== undefined && { balance: tx.observedBalance.toJSON() }),
        idempotentReplay,
      };
    }
    case WagerTransactionStatus.PendingReference: {
      if (tx.nextReferenceCheckAt === undefined) throw new InvalidWagerTransactionError('pendência sem agendamento');
      return {
        type: 'PendingReference',
        transactionId: tx.id,
        status: tx.status,
        nextReferenceCheckAt: tx.nextReferenceCheckAt,
        idempotentReplay,
      };
    }
    case WagerTransactionStatus.Pending:
      throw new InvalidWagerTransactionError('transação PENDING não tem resultado');
  }
}
