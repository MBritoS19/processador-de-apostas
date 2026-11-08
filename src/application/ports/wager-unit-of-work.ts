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
  /**
   * `SELECT ... FOR UPDATE SKIP LOCKED` da wallet (worker de pendentes): `undefined` quando outra
   * transação segura o lock (as pendentes sempre têm wallet do player, garantido pela FK).
   */
  tryLockWallet(walletId: string, playerId: string): Promise<Wallet | undefined>;
  /** `SELECT ... FOR UPDATE` da transação. Só depois do lock da wallet (ordem de locks, ARCHITECTURE.md → "Worker de referências pendentes"). */
  lockTransaction(id: string): Promise<WagerTransaction | undefined>;
  /** Grava o novo estado de uma PENDING_REFERENCE. Lança se a linha não estiver mais pendente (bug: o chamador segura o lock). */
  updatePendingTransaction(tx: WagerTransaction): Promise<void>;
  /** PENDING_REFERENCE vencidas (`next_reference_check_at <= now`), as mais antigas primeiro. Sem lock. */
  findDuePendingReferences(now: Date, limit: number): Promise<PendingReferenceCandidate[]>;
  countPendingReferences(): Promise<number>;
  /**
   * Caminho rápido: antecipa para `now` a próxima checagem das PENDING_REFERENCE da mesma wallet
   * que referenciam `(providerId, externalTransactionId)`. Devolve quantas mudaram.
   */
  expediteAwaitingReference(providerId: string, externalTransactionId: string, walletId: string, now: Date): Promise<number>;
  /** eventId do WagerTransactionPendingReference da transação, se houver. */
  findPendingReferenceEventId(transactionId: string): Promise<string | undefined>;
  /** Abertura de wallet (POST /wallets). Viola `uq_wallets_player_currency` se o player já tem wallet na moeda. */
  insertWallet(wallet: Wallet): Promise<void>;
  /** Wallet do player na moeda, para devolver o id no conflito de abertura. */
  findWalletIdByPlayer(playerId: string, currency: string): Promise<string | undefined>;
}

export interface PendingReferenceCandidate {
  id: string;
  walletId: string;
  playerId: string;
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
 * Qual unicidade foi violada: `idempotency` (key ou externalTransactionId do provider),
 * `inbox` (mesma mensagem do mesmo consumidor) ou `wallet` (player já tem wallet na moeda).
 * Outras violações não são traduzidas: são bug.
 */
export type UniqueViolationKind = 'idempotency' | 'inbox' | 'wallet';

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
