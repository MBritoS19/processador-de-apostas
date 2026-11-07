import { LockMode } from '@mikro-orm/core';
import type { EntityManager } from '@mikro-orm/postgresql';
import {
  TransientPersistenceError,
  UniqueViolationError,
  WalletVersionConflictError,
  type WagerProcessingRepository,
  type WagerUnitOfWork,
} from '../../application/ports/wager-unit-of-work';
import type { InboxMessage } from '../../domain/inbox-message';
import type { OutboxMessage } from '../../domain/outbox-message';
import { WagerTransactionKind, WagerTransactionStatus, type WagerTransaction } from '../../domain/wager-transaction';
import type { Wallet } from '../../domain/wallet';
import type { WalletLedgerEntry } from '../../domain/wallet-ledger-entry';
import { isNetworkError } from '../network-errors';
import { InboxMessageRecord, OutboxMessageRecord, toInboxMessageRecord, toOutboxMessageRecord } from './messages.persistence';
import { WagerTransactionRecord, toWagerTransaction, toWagerTransactionRecord } from './wager-transaction.persistence';
import { LedgerEntryRecord, toLedgerEntryRecord } from './wallet-ledger-entry.persistence';
import { WalletRecord, toWallet } from './wallet.persistence';

export const DEFAULT_LOCK_TIMEOUT_MS = 2_000;

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
      throw translate(error);
    }
  }
}

function translate(error: unknown): unknown {
  const { code, constraint, name } = (error ?? {}) as { code?: unknown; constraint?: unknown; name?: unknown };
  if (code === '23505') return new UniqueViolationError(typeof constraint === 'string' ? constraint : undefined);
  if (typeof code === 'string' && code in TRANSIENT_SQLSTATES) {
    return new TransientPersistenceError(TRANSIENT_SQLSTATES[code as keyof typeof TRANSIENT_SQLSTATES], { cause: error });
  }
  // Pool esgotado (tarn/knex) ou banco fora do ar.
  if (name === 'KnexTimeoutError' || name === 'ConnectionException' || isNetworkError(error)) {
    return new TransientPersistenceError('unavailable', { cause: error });
  }
  return error;
}

class MikroOrmWagerProcessingRepository implements WagerProcessingRepository {
  constructor(private readonly em: EntityManager) {}

  async lockWallet(walletId: string): Promise<Wallet | undefined> {
    const record = await this.em.findOne(WalletRecord, { id: walletId }, { lockMode: LockMode.PESSIMISTIC_WRITE });
    return record ? toWallet(record) : undefined;
  }

  async findByIdempotency(
    idempotencyKey: string,
    providerId: string,
    externalTransactionId: string,
  ): Promise<WagerTransaction[]> {
    const records = await this.em.find(WagerTransactionRecord, {
      $or: [{ idempotencyKey }, { providerId, externalTransactionId }],
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
      kind: { $in: [WagerTransactionKind.Refund, WagerTransactionKind.Rollback] },
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

  async insertOutbox(messages: readonly OutboxMessage[]): Promise<void> {
    if (messages.length === 0) return;
    await this.em.insertMany(OutboxMessageRecord, messages.map(toOutboxMessageRecord));
  }

  async insertInbox(message: InboxMessage): Promise<void> {
    await this.em.insert(InboxMessageRecord, toInboxMessageRecord(message));
  }
}
