import type { InboxMessage } from '../../domain/inbox-message';
import type { OutboxMessage } from '../../domain/outbox-message';
import type { WagerTransaction } from '../../domain/wager-transaction';
import type { Wallet } from '../../domain/wallet';
import type { WalletLedgerEntry } from '../../domain/wallet-ledger-entry';

/**
 * Operações disponíveis dentro de UMA transação SQL. Tudo o que é gravado aqui (transação,
 * saldo, ledger, outbox, inbox) é confirmado junto no COMMIT, ou nada é.
 */
export interface WagerProcessingRepository {
  /**
   * `SELECT ... FOR UPDATE` da wallet do player: a única linha travada pela transação.
   * Uma wallet de outro player não é travada (quem não é dono não segura o lock dela).
   */
  lockWallet(walletId: string, playerId: string): Promise<Wallet | undefined>;
  /** Leitura sem lock, só para distinguir WALLET_NOT_FOUND de WALLET_PLAYER_MISMATCH. */
  walletExists(walletId: string): Promise<boolean>;
  /** Transações do provider com a idempotency key OU com o mesmo externalTransactionId. */
  findByIdempotency(providerId: string, idempotencyKey: string, externalTransactionId: string): Promise<WagerTransaction[]>;
  /** Resolve uma referência pelo id externo no provedor. */
  findByExternalId(providerId: string, externalTransactionId: string): Promise<WagerTransaction | undefined>;
  /** Existe REFUND ou ROLLBACK PROCESSED desta transação? */
  hasProcessedReversal(referenceTransactionId: string): Promise<boolean>;
  insertTransaction(tx: WagerTransaction): Promise<void>;
  /** `UPDATE ... WHERE id = ? AND version = ?`; lança `WalletVersionConflictError` se nenhuma linha mudar. */
  updateWallet(wallet: Wallet, expectedVersion: number): Promise<void>;
  insertLedgerEntry(entry: WalletLedgerEntry): Promise<void>;
  insertOutbox(messages: readonly OutboxMessage[]): Promise<void>;
  insertInbox(message: InboxMessage): Promise<void>;
}

/**
 * Executa `work` numa transação SQL nova, com `lock_timeout` local. Erros do banco saem
 * traduzidos: `UniqueViolationError`, `TransientPersistenceError`; o resto é relançado.
 */
export interface WagerUnitOfWork {
  run<T>(work: (repository: WagerProcessingRepository) => Promise<T>): Promise<T>;
}

/** A segunda barreira (version) detectou escrita concorrente na wallet. */
export class WalletVersionConflictError extends Error {
  constructor(readonly walletId: string) {
    super(`wallet ${walletId}: version divergente no UPDATE`);
    this.name = 'WalletVersionConflictError';
  }
}

/**
 * Qual unicidade foi violada: `idempotency` (key ou externalTransactionId do provider) ou
 * `inbox` (mesma mensagem do mesmo consumidor). Outras violações não são traduzidas: são bug.
 */
export type UniqueViolationKind = 'idempotency' | 'inbox';

/** Violação de unicidade (SQLSTATE 23505) esperada sob concorrência. A transação já sofreu rollback. */
export class UniqueViolationError extends Error {
  constructor(
    readonly kind: UniqueViolationKind,
    options?: { cause?: unknown },
  ) {
    super(`violação de unicidade (${kind})`, options);
    this.name = 'UniqueViolationError';
  }
}

export type TransientPersistenceReason = 'lock_timeout' | 'deadlock' | 'serialization' | 'unavailable';

/** Falha que pode passar sozinha: o chamador pode reenviar a mesma requisição. */
export class TransientPersistenceError extends Error {
  constructor(
    readonly reason: TransientPersistenceReason,
    options?: { cause?: unknown },
  ) {
    super(`falha transitória de persistência: ${reason}`, options);
    this.name = 'TransientPersistenceError';
  }
}
