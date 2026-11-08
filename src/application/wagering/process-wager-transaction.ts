import { InvalidMoneyError, InvalidWagerTransactionError } from '../../domain/errors';
import type { FailureCode } from '../../domain/failure-code';
import { InboxMessage } from '../../domain/inbox-message';
import { Money, type MoneyProps } from '../../domain/money';
import {
  INTERNAL_PROVIDER_ID,
  OPENING_KEY_PREFIX,
  WagerTransaction,
  WagerTransactionKind,
  WagerTransactionStatus,
} from '../../domain/wager-transaction';
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
import { UUID_PATTERN, textProblem } from '../validation';
import { wagerPayloadHash } from './payload-hash';
import type { WagerSettlement } from './wager-settlement';

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

/**
 * Processa uma transação de aposta (BET, WIN, LOSS, REFUND, ROLLBACK) com idempotência
 * persistida e lock pessimista por wallet. Usado pela entrada HTTP (Fase 4) e SQS (Fase 5).
 * Estratégia e SQL exato no ARCHITECTURE.md → "Concorrência".
 */
export class ProcessWagerTransaction {
  constructor(
    private readonly unitOfWork: WagerUnitOfWork,
    private readonly clock: Clock,
    private readonly ids: IdGenerator,
    private readonly telemetry: LockConflictTelemetry,
    private readonly settlement: WagerSettlement,
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
        correlationId: command.correlationId,
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

    await this.settlement.settle(repository, tx, wallet, {
      now: this.clock.now(),
      correlationId: command.correlationId,
      // A mensagem de entrada (inbox) ou a requisição (idempotency key).
      causationId: command.inbox?.messageId ?? command.idempotencyKey,
    }, 'insert');
    if (command.inbox) await repository.insertInbox(this.inboxMessage(command.inbox));

    return resultOf(tx, false);
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
