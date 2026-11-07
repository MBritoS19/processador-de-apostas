import { WagerTransactionStatus } from '../../domain/wager-transaction';
import type { Clock } from '../ports/clock';
import {
  TransientPersistenceError,
  WalletVersionConflictError,
  type PendingReferenceCandidate,
  type TransientPersistenceReason,
  type WagerUnitOfWork,
} from '../ports/wager-unit-of-work';
import type { WagerSettlement } from './wager-settlement';

/**
 * Resultado de uma candidata:
 * - `resolved`: virou PROCESSED ou REJECTED por regra de negócio (referência encontrada);
 * - `expired`: prazo esgotado → REJECTED com REFERENCE_NOT_FOUND;
 * - `rescheduled`: referência ainda ausente ou não resolvida → nova tentativa com backoff;
 * - `skipped`: wallet ocupada, candidata já tratada por outra instância ou ainda não vencida;
 * - `transient`: lock timeout, deadlock, banco fora (a candidata continua vencida e volta no próximo ciclo).
 */
export type PendingReferenceOutcome =
  | { type: 'resolved'; transactionId: string; status: WagerTransactionStatus.Processed | WagerTransactionStatus.Rejected }
  | { type: 'expired'; transactionId: string }
  | { type: 'rescheduled'; transactionId: string; nextReferenceCheckAt: Date }
  | { type: 'skipped'; transactionId: string; reason: 'wallet_busy' | 'not_due' }
  | { type: 'transient'; transactionId: string; reason: TransientPersistenceReason | 'version_conflict' };

/**
 * Reprocessa transações PENDING_REFERENCE (CHALLENGE §7.1) com as mesmas regras da entrada
 * (`WagerSettlement`). Ordem de locks igual à do use case: wallet → transação. Seguro com N
 * instâncias: a candidata é relida sob lock e só é tratada se ainda estiver pendente e vencida.
 * Fluxo e números no ARCHITECTURE §20.
 */
export class ResolvePendingReferences {
  constructor(
    private readonly unitOfWork: WagerUnitOfWork,
    private readonly clock: Clock,
    private readonly settlement: WagerSettlement,
  ) {}

  /** Candidatas vencidas, sem lock (a decisão é tomada em `resolve`, sob lock). */
  findDue(limit: number): Promise<PendingReferenceCandidate[]> {
    return this.unitOfWork.run((repository) => repository.findDuePendingReferences(this.clock.now(), limit));
  }

  countPending(): Promise<number> {
    return this.unitOfWork.run((repository) => repository.countPendingReferences());
  }

  /** Uma candidata numa transação SQL própria. Erros que não são transitórios são bug e saem lançados. */
  async resolve(candidate: PendingReferenceCandidate): Promise<PendingReferenceOutcome> {
    const transactionId = candidate.id;
    try {
      return await this.unitOfWork.run(async (repository): Promise<PendingReferenceOutcome> => {
        // SKIP LOCKED: wallet em uso (use case ou outra instância) → tenta no próximo ciclo, sem esperar.
        const wallet = await repository.tryLockWallet(candidate.walletId, candidate.playerId);
        if (wallet === undefined) return { type: 'skipped', transactionId, reason: 'wallet_busy' };

        const tx = await repository.lockTransaction(transactionId);
        const now = this.clock.now();
        const due =
          tx?.status === WagerTransactionStatus.PendingReference &&
          tx.nextReferenceCheckAt !== undefined &&
          tx.nextReferenceCheckAt <= now;
        if (tx === undefined || !due) return { type: 'skipped', transactionId, reason: 'not_due' };

        // Sem evento de pendência gravado (não acontece pelo use case): a própria transação é a causa.
        const causationId = (await repository.findPendingReferenceEventId(tx.id)) ?? tx.id;
        const { expired } = await this.settlement.settle(
          repository,
          tx,
          wallet,
          // Linhas anteriores à coluna correlation_id: o id da transação correlaciona.
          { now, correlationId: tx.correlationId ?? tx.id, causationId },
          'update',
        );

        if (expired) return { type: 'expired', transactionId };
        // settle muda o status: o estreitamento feito pelo `due` acima não vale mais.
        const status = tx.status as WagerTransactionStatus;
        switch (status) {
          case WagerTransactionStatus.Processed:
          case WagerTransactionStatus.Rejected:
            return { type: 'resolved', transactionId, status };
          case WagerTransactionStatus.PendingReference:
            return { type: 'rescheduled', transactionId, nextReferenceCheckAt: tx.nextReferenceCheckAt as Date };
          default:
            throw new Error(`estado inesperado após o reprocessamento: ${status}`);
        }
      });
    } catch (error) {
      if (error instanceof WalletVersionConflictError) return { type: 'transient', transactionId, reason: 'version_conflict' };
      if (error instanceof TransientPersistenceError) return { type: 'transient', transactionId, reason: error.reason };
      throw error;
    }
  }
}
