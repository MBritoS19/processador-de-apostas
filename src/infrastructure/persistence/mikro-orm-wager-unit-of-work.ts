import { LockMode } from '@mikro-orm/core';
import type { EntityManager } from '@mikro-orm/postgresql';
import {
  JournalIntegrityError,
  TransientPersistenceError,
  UniqueViolationError,
  WalletVersionConflictError,
  type PendingReferenceCandidate,
  type UniqueViolationKind,
  type WagerProcessingRepository,
  type WagerUnitOfWork,
} from '../../application/ports/wager-unit-of-work';
import type { InboxMessage } from '../../domain/inbox-message';
import type { JournalEntry } from '../../domain/journal-entry';
import type { OutboxMessage } from '../../domain/outbox-message';
import { REVERSAL_KINDS, WagerTransactionStatus, type WagerTransaction } from '../../domain/wager-transaction';
import type { Wallet } from '../../domain/wallet';
import type { WalletLedgerEntry } from '../../domain/wallet-ledger-entry';
import { isNetworkError } from '../network-errors';
import { insertJournalEntry } from './journal.persistence';
import { InboxMessageRecord, OutboxMessageRecord, toInboxMessageRecord, toOutboxMessageRecord } from './messages.persistence';
import { WagerTransactionRecord, toWagerTransaction, toWagerTransactionRecord } from './wager-transaction.persistence';
import { LedgerEntryRecord, toLedgerEntryRecord } from './wallet-ledger-entry.persistence';
import { WalletRecord, toWallet, toWalletRecord } from './wallet.persistence';

/** Worker de pendentes e abertura de wallet: uma tentativa, até 2s. */
const DEFAULT_LOCK_TIMEOUT_MS = 2_000;
/**
 * `ProcessWagerTransaction`: 1s por tentativa, com 1 tentativa extra no use case. O orçamento total
 * de espera pelo lock continua ~2s antes do 503 (ARCHITECTURE.md → "Concorrência"). Curto de propósito:
 * quem espera o lock ocupa uma conexão do pool, e uma espera longa esgotaria o pool para as outras wallets.
 */
export const WAGER_LOCK_TIMEOUT_MS = 1_000;

/** SQLSTATEs que significam "tente de novo": lock_not_available, deadlock, serialization_failure. */
const TRANSIENT_SQLSTATES = {
  '55P03': 'lock_timeout',
  '40P01': 'deadlock',
  '40001': 'serialization',
} as const;

/**
 * Cada `run` abre um EntityManager novo (fork) e uma transação SQL própria, com
 * `SET LOCAL lock_timeout`. Nenhum estado é compartilhado entre chamadas.
 */
export class MikroOrmWagerUnitOfWork implements WagerUnitOfWork {
  constructor(
    private readonly em: EntityManager,
    private readonly lockTimeoutMs: number = DEFAULT_LOCK_TIMEOUT_MS,
  ) {
    if (!Number.isInteger(lockTimeoutMs) || lockTimeoutMs <= 0) {
      throw new RangeError('lockTimeoutMs deve ser um inteiro positivo');
    }
  }

  async run<T>(work: (repository: WagerProcessingRepository) => Promise<T>): Promise<T> {
    try {
      return await this.em.fork().transactional(async (em) => {
        // Inteiro validado no construtor: sem risco de injeção.
        await em.execute(`set local lock_timeout = '${this.lockTimeoutMs}ms'`);
        return work(new MikroOrmWagerProcessingRepository(em));
      });
    } catch (error) {
      throw translatePersistenceError(error);
    }
  }
}

/** Unicidades que concorrência ou reentrega violam legitimamente. As demais são bug e saem sem tradução. */
const EXPECTED_UNIQUE_VIOLATIONS: Readonly<Record<string, UniqueViolationKind>> = {
  uq_wager_tx_provider_idempotency_key: 'idempotency',
  uq_wager_tx_provider_external: 'idempotency',
  pk_inbox_messages: 'inbox',
  uq_wallets_player_currency: 'wallet',
};

/** Constraint trigger do diário (migration `…20261109000000_double_entry_journal`): violação é permanente. */
const JOURNAL_BALANCED_CONSTRAINT = 'trg_journal_balanced';

/** Traduz erros do driver/ORM para os erros da porta. Exportada para teste. */
export function translatePersistenceError(error: unknown): unknown {
  const { code, constraint, name } = (error ?? {}) as { code?: unknown; constraint?: unknown; name?: unknown };
  if (code === '23514' && constraint === JOURNAL_BALANCED_CONSTRAINT) return new JournalIntegrityError({ cause: error });
  if (code === '23505' && typeof constraint === 'string' && Object.hasOwn(EXPECTED_UNIQUE_VIOLATIONS, constraint)) {
    return new UniqueViolationError(EXPECTED_UNIQUE_VIOLATIONS[constraint] as UniqueViolationKind, { cause: error });
  }
  if (typeof code === 'string' && Object.hasOwn(TRANSIENT_SQLSTATES, code)) {
    return new TransientPersistenceError(TRANSIENT_SQLSTATES[code as keyof typeof TRANSIENT_SQLSTATES], { cause: error });
  }
  // Banco fora do ar: o knex propaga o erro de criação da conexão (propagateCreateError).
  if (name === 'ConnectionException' || isNetworkError(error)) {
    return new TransientPersistenceError('unavailable', { cause: error });
  }
  // Pool esgotado (tarn/knex): o banco responde, mas não houve conexão livre a tempo.
  if (name === 'KnexTimeoutError') return new TransientPersistenceError('pool_exhausted', { cause: error });
  return error;
}

class MikroOrmWagerProcessingRepository implements WagerProcessingRepository {
  constructor(private readonly em: EntityManager) {}

  /**
   * `FOR UPDATE` serializa por wallet: duas BETs sobre o mesmo saldo nunca leem o mesmo valor. O filtro
   * por `playerId` evita que um player que não é dono segure (ou espere) o lock de outra wallet.
   * ARCHITECTURE.md → "Concorrência" (CHALLENGE §8).
   */
  async lockWallet(walletId: string, playerId: string): Promise<Wallet | undefined> {
    const record = await this.em.findOne(
      WalletRecord,
      { id: walletId, playerId },
      { lockMode: LockMode.PESSIMISTIC_WRITE },
    );
    return record ? toWallet(record) : undefined;
  }

  async walletExists(walletId: string): Promise<boolean> {
    return (await this.em.count(WalletRecord, { id: walletId })) > 0;
  }

  async findByIdempotency(
    providerId: string,
    idempotencyKey: string,
    externalTransactionId: string,
  ): Promise<WagerTransaction[]> {
    const records = await this.em.find(WagerTransactionRecord, {
      providerId,
      $or: [{ idempotencyKey }, { externalTransactionId }],
    });
    return records.map(toWagerTransaction);
  }

  async findByExternalId(providerId: string, externalTransactionId: string): Promise<WagerTransaction | undefined> {
    const record = await this.em.findOne(WagerTransactionRecord, { providerId, externalTransactionId });
    return record ? toWagerTransaction(record) : undefined;
  }

  async hasProcessedReversal(referenceTransactionId: string): Promise<boolean> {
    const count = await this.em.count(WagerTransactionRecord, {
      referenceTransactionId,
      kind: { $in: [...REVERSAL_KINDS] },
      status: WagerTransactionStatus.Processed,
    });
    return count > 0;
  }

  async insertTransaction(tx: WagerTransaction): Promise<void> {
    await this.em.insert(WagerTransactionRecord, toWagerTransactionRecord(tx));
  }

  async updateWallet(wallet: Wallet, expectedVersion: number): Promise<void> {
    const affected = await this.em.nativeUpdate(
      WalletRecord,
      { id: wallet.id, version: expectedVersion },
      { balance: wallet.balance.amount, version: wallet.version, updatedAt: wallet.updatedAt },
    );
    if (affected !== 1) throw new WalletVersionConflictError(wallet.id);
  }

  async insertLedgerEntry(entry: WalletLedgerEntry): Promise<void> {
    await this.em.insert(LedgerEntryRecord, toLedgerEntryRecord(entry));
  }

  async insertJournalEntry(entry: JournalEntry): Promise<void> {
    await insertJournalEntry(this.em, entry);
  }

  async insertOutbox(messages: readonly OutboxMessage[]): Promise<void> {
    if (messages.length === 0) return;
    await this.em.insertMany(OutboxMessageRecord, messages.map(toOutboxMessageRecord));
  }

  async insertInbox(message: InboxMessage): Promise<void> {
    await this.em.insert(InboxMessageRecord, toInboxMessageRecord(message));
  }

  async tryLockWallet(walletId: string, playerId: string): Promise<Wallet | undefined> {
    const record = await this.em.findOne(
      WalletRecord,
      { id: walletId, playerId },
      { lockMode: LockMode.PESSIMISTIC_PARTIAL_WRITE },
    );
    return record ? toWallet(record) : undefined;
  }

  async lockTransaction(id: string): Promise<WagerTransaction | undefined> {
    const record = await this.em.findOne(WagerTransactionRecord, { id }, { lockMode: LockMode.PESSIMISTIC_WRITE });
    return record ? toWagerTransaction(record) : undefined;
  }

  async updatePendingTransaction(tx: WagerTransaction): Promise<void> {
    const { status, referenceTransactionId, failureCode, processedAt, observedBalance, referenceAttempts, nextReferenceCheckAt } =
      toWagerTransactionRecord(tx);
    const affected = await this.em.nativeUpdate(
      WagerTransactionRecord,
      { id: tx.id, status: WagerTransactionStatus.PendingReference },
      { status, referenceTransactionId, failureCode, processedAt, observedBalance, referenceAttempts, nextReferenceCheckAt },
    );
    if (affected !== 1) throw new Error(`transação ${tx.id} não está mais em PENDING_REFERENCE`);
  }

  async findDuePendingReferences(now: Date, limit: number): Promise<PendingReferenceCandidate[]> {
    // Servida pelo índice parcial ix_wager_tx_reference_check_due. Desempate por (created_at, id): sem ele,
    // pendentes que vencem no mesmo instante saem em ordem indefinida, e o desfecho de uma pendente que
    // referencia outra muda com a ordem (ARCHITECTURE.md → "Worker de referências pendentes").
    const rows = await this.em.execute<Array<{ id: string; wallet_id: string; player_id: string }>>(
      `select id, wallet_id, player_id from wager_transactions
       where status = 'PENDING_REFERENCE' and next_reference_check_at <= ?
       order by next_reference_check_at, created_at, id
       limit ?`,
      [now, limit],
    );
    return rows.map((row) => ({ id: row.id, walletId: row.wallet_id, playerId: row.player_id }));
  }

  async countPendingReferences(): Promise<number> {
    return this.em.count(WagerTransactionRecord, { status: WagerTransactionStatus.PendingReference });
  }

  async expediteAwaitingReference(
    providerId: string,
    externalTransactionId: string,
    walletId: string,
    now: Date,
  ): Promise<number> {
    // Servida pelo índice parcial ix_wager_tx_awaiting_reference. Só linhas da wallet já travada.
    return this.em.nativeUpdate(
      WagerTransactionRecord,
      {
        status: WagerTransactionStatus.PendingReference,
        providerId,
        referenceExternalTransactionId: externalTransactionId,
        walletId,
        nextReferenceCheckAt: { $gt: now },
      },
      { nextReferenceCheckAt: now },
    );
  }

  async findPendingReferenceEventId(transactionId: string): Promise<string | undefined> {
    const rows = await this.em.execute<Array<{ id: string }>>(
      `select id from outbox_messages where aggregate_id = ? and event_type = 'WagerTransactionPendingReference'
       order by seq limit 1`,
      [transactionId],
    );
    return rows[0]?.id;
  }

  async insertWallet(wallet: Wallet): Promise<void> {
    await this.em.insert(WalletRecord, toWalletRecord(wallet));
  }

  async findWalletIdByPlayer(playerId: string, currency: string): Promise<string | undefined> {
    const record = await this.em.findOne(WalletRecord, { playerId, currency });
    return record?.id;
  }
}
