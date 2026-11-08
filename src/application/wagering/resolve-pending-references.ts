import { WagerTransactionStatus, type WagerTransaction } from '../../domain/wager-transaction';
import type { Wallet } from '../../domain/wallet';
import type { Clock } from '../ports/clock';
import {
  TransientPersistenceError,
  WalletVersionConflictError,
  type PendingReferenceCandidate,
  type TransientPersistenceReason,
  type WagerProcessingRepository,
  type WagerUnitOfWork,
} from '../ports/wager-unit-of-work';
import type { SettlementContext, WagerSettlement } from './wager-settlement';

/**
 * Resultado de uma candidata:
 * - `resolved`: virou PROCESSED ou REJECTED por regra de negócio (referência encontrada);
 * - `expired`: prazo esgotado → REJECTED com REFERENCE_NOT_FOUND;
 * - `rescheduled`: referência ainda ausente ou não resolvida → nova tentativa com backoff;
 * - `failed`: encerrada como FAILED (INFRASTRUCTURE_FAILURE) por erro inesperado repetido;
 * - `skipped`: wallet ocupada, candidata já tratada por outra instância ou ainda não vencida;
 * - `transient`: lock timeout, deadlock, banco fora (a candidata continua vencida e volta no próximo ciclo).
 */
export type PendingReferenceOutcome =
  | { type: 'resolved'; transactionId: string; status: WagerTransactionStatus.Processed | WagerTransactionStatus.Rejected }
  | { type: 'expired'; transactionId: string }
  | { type: 'rescheduled'; transactionId: string; nextReferenceCheckAt: Date }
  | { type: 'failed'; transactionId: string }
  | { type: 'skipped'; transactionId: string; reason: 'wallet_busy' | 'not_due' }
  | { type: 'transient'; transactionId: string; reason: TransientPersistenceReason | 'version_conflict' };

export interface ResolveOptions {
  /**
   * false (padrão): `SKIP LOCKED` na wallet, ocupada → `wallet_busy`. true: espera o lock com o
   * `lock_timeout` da transação (o worker usa depois de vários `wallet_busy` seguidos).
   */
  waitForWallet?: boolean;
}

type Locked = { type: 'locked'; wallet: Wallet; tx: WagerTransaction } | Extract<PendingReferenceOutcome, { type: 'skipped' }>;

/**
 * Reprocessa transações PENDING_REFERENCE (CHALLENGE §7.1) com as mesmas regras da entrada
 * (`WagerSettlement`). Ordem de locks igual à do use case: wallet → transação. Seguro com N
 * instâncias: a candidata é relida sob lock e só é tratada se ainda estiver pendente (e vencida).
 * Fluxo e números no ARCHITECTURE.md → "Worker de referências pendentes".
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
  resolve(candidate: PendingReferenceCandidate, options: ResolveOptions = {}): Promise<PendingReferenceOutcome> {
    const transactionId = candidate.id;
    return this.transactional(transactionId, async (repository) => {
      const now = this.clock.now();
      const locked = await this.lock(repository, candidate, options.waitForWallet ?? false, now, true);
      if (locked.type !== 'locked') return locked;
      const { wallet, tx } = locked;

      const { expired } = await this.settlement.settle(repository, tx, wallet, await this.context(repository, tx, now), 'update');
      if (expired) return { type: 'expired', transactionId };
      // settle muda o status: o estreitamento feito em `lock` não vale mais.
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
  }

  /**
   * Encerra a candidata como FAILED (INFRASTRUCTURE_FAILURE) com evento de rejeição. Usado pelo
   * worker depois de erros inesperados repetidos. Espera o lock da wallet (com lock_timeout); se a
   * candidata já não estiver pendente, nada muda (`not_due`).
   */
  fail(candidate: PendingReferenceCandidate): Promise<PendingReferenceOutcome> {
    const transactionId = candidate.id;
    return this.transactional(transactionId, async (repository) => {
      const now = this.clock.now();
      const locked = await this.lock(repository, candidate, true, now, false);
      if (locked.type !== 'locked') return locked;
      await this.settlement.fail(repository, locked.tx, await this.context(repository, locked.tx, now));
      return { type: 'failed', transactionId };
    });
  }

  /**
   * Ordem de locks: wallet, depois a transação, relida e conferida como pendente (e vencida, se `requireDue`).
   * É a mesma do use case (wallet primeiro): travar a transação antes da wallet cruzaria com ele e abriria
   * deadlock. `SKIP LOCKED` na wallet evita esperar atrás do tráfego de entrada; a releitura sob lock
   * descarta a candidata que outra instância já resolveu (ARCHITECTURE.md → "Worker de referências pendentes").
   */
  private async lock(
    repository: WagerProcessingRepository,
    candidate: PendingReferenceCandidate,
    waitForWallet: boolean,
    now: Date,
    requireDue: boolean,
  ): Promise<Locked> {
    const transactionId = candidate.id;
    const wallet = waitForWallet
      ? await repository.lockWallet(candidate.walletId, candidate.playerId)
      : await repository.tryLockWallet(candidate.walletId, candidate.playerId);
    // Com SKIP LOCKED, undefined = wallet em uso (as pendentes sempre têm wallet do player, pela FK).
    if (wallet === undefined) return { type: 'skipped', transactionId, reason: 'wallet_busy' };

    const tx = await repository.lockTransaction(transactionId);
    const pending = tx?.status === WagerTransactionStatus.PendingReference && tx.nextReferenceCheckAt !== undefined;
    const due = pending && (!requireDue || (tx.nextReferenceCheckAt as Date) <= now);
    if (tx === undefined || !due) return { type: 'skipped', transactionId, reason: 'not_due' };
    return { type: 'locked', wallet, tx };
  }

  /**
   * correlationId: o gravado na transação (linhas anteriores à coluna: o id da transação).
   * causationId: o evento de pendência; sem ele (não acontece pelo use case), a própria transação.
   */
  private async context(repository: WagerProcessingRepository, tx: WagerTransaction, now: Date): Promise<SettlementContext> {
    const causationId = (await repository.findPendingReferenceEventId(tx.id)) ?? tx.id;
    return { now, correlationId: tx.correlationId ?? tx.id, causationId };
  }

  private async transactional(
    transactionId: string,
    work: (repository: WagerProcessingRepository) => Promise<PendingReferenceOutcome>,
  ): Promise<PendingReferenceOutcome> {
    try {
      return await this.unitOfWork.run(work);
    } catch (error) {
      if (error instanceof WalletVersionConflictError) return { type: 'transient', transactionId, reason: 'version_conflict' };
      if (error instanceof TransientPersistenceError) return { type: 'transient', transactionId, reason: error.reason };
      throw error;
    }
  }
}
