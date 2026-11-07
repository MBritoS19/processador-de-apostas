import type { EntityManager } from '@mikro-orm/postgresql';
import type { OpenWallet } from '../../application/wallets/open-wallet';
import {
  UUID_PATTERN,
  textProblem,
  type ProcessWagerTransaction,
  type ProcessWagerTransactionResult,
  type WagerTransactionPayload,
} from '../../application/wagering/process-wager-transaction';
import { INTERNAL_PROVIDER_ID } from '../../domain/wager-transaction';
import { rootLogger } from '../../infrastructure/observability/logger';
import type { ObservabilityMetrics } from '../../infrastructure/observability/metrics';
import { WagerTransactionRecord } from '../../infrastructure/persistence/wager-transaction.persistence';
import { WalletRecord } from '../../infrastructure/persistence/wallet.persistence';
import { ApiError } from './api-error';

export interface HttpResult {
  status: number;
  body: Record<string, unknown>;
}

export const DEFAULT_LEDGER_LIMIT = 50;
export const MAX_LEDGER_LIMIT = 200;
const MAX_SEQ = 9_223_372_036_854_775_807n;
const CURSOR_PATTERN = /^v1:(\d{1,19})$/;

/**
 * Borda HTTP: traduz entrada e resultados. Escritas passam pelos use cases; consultas leem
 * direto do banco. Erros saem como `ApiError` (envelope único do `ApiExceptionFilter`).
 */
export class WageringHttpService {
  private readonly logger = rootLogger.child({ name: 'WageringHttp' });

  constructor(
    private readonly em: EntityManager,
    private readonly process: Pick<ProcessWagerTransaction, 'execute'>,
    private readonly openWallet: Pick<OpenWallet, 'execute'>,
    private readonly metrics: ObservabilityMetrics,
  ) {}

  async createWallet(input: unknown, correlationId: string): Promise<HttpResult> {
    const body = (input ?? {}) as Record<string, unknown>;
    const result = await this.openWallet.execute({
      playerId: body.playerId,
      initialBalance: body.initialBalance,
      correlationId,
    });
    switch (result.type) {
      case 'Opened':
        return { status: 201, body: result.wallet };
      case 'InvalidInput':
        throw ApiError.invalidInput(result.reason);
      case 'WalletAlreadyExists':
        throw new ApiError(
          409,
          'WALLET_ALREADY_EXISTS',
          'o player já tem wallet nesta moeda',
          result.existingWalletId === undefined ? {} : { walletId: result.existingWalletId },
        );
      case 'TransientFailure':
        throw ApiError.transient();
    }
  }

  async submit(idempotencyKey: unknown, correlationId: string, payload: unknown): Promise<HttpResult> {
    if (typeof idempotencyKey !== 'string' || idempotencyKey.trim() === '') {
      throw ApiError.invalidInput('Idempotency-Key é obrigatório');
    }
    const result = await this.process.execute({
      idempotencyKey,
      payload: payload as WagerTransactionPayload,
      correlationId,
    });
    return mapResult(result);
  }

  async findWallet(id: string): Promise<HttpResult> {
    assertUuid('walletId', id);
    const row = await this.em.fork().findOne(WalletRecord, { id });
    if (!row) throw ApiError.notFound('wallet não encontrada');
    return {
      status: 200,
      body: { id: row.id, playerId: row.playerId, balance: { amount: row.balance, currency: row.currency }, version: row.version },
    };
  }

  async findTransaction(id: string): Promise<HttpResult> {
    assertUuid('transactionId', id);
    const row = await this.em.fork().findOne(WagerTransactionRecord, { id });
    if (!row) throw ApiError.notFound('transação não encontrada');
    return { status: 200, body: transactionBody(row) };
  }

  async findProviderTransaction(providerId: string, externalTransactionId: string): Promise<HttpResult> {
    const problem = textProblem('providerId', providerId) ?? textProblem('externalTransactionId', externalTransactionId);
    if (problem) throw ApiError.invalidInput(problem);
    if (providerId === INTERNAL_PROVIDER_ID) throw ApiError.invalidInput(`providerId "${INTERNAL_PROVIDER_ID}" é reservado`);
    const row = await this.em.fork().findOne(WagerTransactionRecord, { providerId, externalTransactionId });
    if (!row) throw ApiError.notFound('transação não encontrada');
    return { status: 200, body: transactionBody(row) };
  }

  /**
   * Página por `seq` (identity). Lançamentos de uma wallet só são gravados sob o lock dela,
   * então `seq` cresce na ordem de commit dentro da wallet: o cursor não pula nem repete itens.
   */
  async ledger(walletId: string, cursor: unknown, limitValue: unknown): Promise<HttpResult> {
    assertUuid('walletId', walletId);
    const limit = parseLimit(limitValue);
    const after = parseCursor(cursor);
    const em = this.em.fork();
    if ((await em.count(WalletRecord, { id: walletId })) === 0) throw ApiError.notFound('wallet não encontrada');
    const rows = await em
      .getKnex()('wallet_ledger_entries')
      .where('wallet_id', walletId)
      .andWhere('seq', '>', after.toString())
      .orderBy('seq', 'asc')
      .limit(limit + 1);
    const page = rows.slice(0, limit);
    const last = page.at(-1);
    return {
      status: 200,
      body: {
        items: page.map((row) => ({
          id: row.id,
          transactionId: row.transaction_id,
          direction: row.direction,
          money: { amount: String(row.amount), currency: row.currency },
          balanceBefore: { amount: String(row.balance_before), currency: row.currency },
          balanceAfter: { amount: String(row.balance_after), currency: row.currency },
          createdAt: row.created_at,
        })),
        nextCursor: rows.length > limit && last !== undefined ? encodeCursor(String(last.seq)) : null,
      },
    };
  }

  /** Compara o saldo com a soma do ledger num único statement. Nunca corrige: loga, conta e sinaliza. */
  async reconcile(walletId: string, correlationId: string): Promise<HttpResult> {
    assertUuid('walletId', walletId);
    const { rows } = await this.em.getKnex().raw<{
      rows: Array<{ balance: string; currency: string; calculated: string; difference: string; entries: string }>;
    }>(
      `select w.balance::text as balance, w.currency,
              l.calculated::text as calculated,
              (w.balance - l.calculated)::numeric(21,2)::text as difference,
              l.entries::text as entries
         from wallets w
         cross join lateral (
           select coalesce(sum(case direction when 'CREDIT' then amount else -amount end), 0)::numeric(21,2) as calculated,
                  count(*) as entries
             from wallet_ledger_entries
            where wallet_id = w.id
         ) l
        where w.id = ?`,
      [walletId],
    );
    const [row] = rows;
    if (!row) throw ApiError.notFound('wallet não encontrada');
    const consistent = row.difference === '0.00';
    if (!consistent) {
      this.metrics.reconciliationDivergences.inc();
      this.logger.warn({ event: 'reconciliation_divergence', walletId, correlationId }, 'reconciliation divergence');
    }
    return {
      status: 200,
      body: {
        walletId,
        storedBalance: { amount: row.balance, currency: row.currency },
        calculatedBalance: { amount: row.calculated, currency: row.currency },
        difference: { amount: row.difference, currency: row.currency },
        consistent,
        checkedEntries: Number(row.entries),
      },
    };
  }
}

/** Rejected (REJECTED e FAILED) → 422 com failureCode; 503 é exclusivo de TransientFailure. */
function mapResult(result: ProcessWagerTransactionResult): HttpResult {
  switch (result.type) {
    case 'Processed':
      return {
        status: 200,
        body: { transactionId: result.transactionId, status: result.status, balance: result.balance, idempotentReplay: result.idempotentReplay },
      };
    case 'PendingReference':
      return {
        status: 202,
        body: {
          transactionId: result.transactionId,
          status: result.status,
          nextReferenceCheckAt: result.nextReferenceCheckAt.toISOString(),
          idempotentReplay: result.idempotentReplay,
        },
      };
    case 'Rejected':
      return {
        status: 422,
        body: {
          transactionId: result.transactionId,
          status: result.status,
          failureCode: result.failureCode,
          ...(result.balance ? { balance: result.balance } : {}),
          idempotentReplay: result.idempotentReplay,
        },
      };
    case 'InvalidInput':
      throw ApiError.invalidInput(result.reason);
    case 'IdempotencyConflict':
      throw new ApiError(
        409,
        'IDEMPOTENCY_CONFLICT',
        'a Idempotency-Key (ou o id externo) já foi usada com outro payload',
        result.existingTransactionId === undefined ? {} : { existingTransactionId: result.existingTransactionId },
      );
    case 'TransientFailure':
      throw ApiError.transient();
  }
}

function assertUuid(field: string, value: string): void {
  if (!UUID_PATTERN.test(value)) throw ApiError.invalidInput(`${field} deve ser um UUID`);
}

function parseLimit(value: unknown): number {
  if (value === undefined) return DEFAULT_LEDGER_LIMIT;
  const limit = typeof value === 'string' && /^\d{1,3}$/.test(value) ? Number(value) : 0;
  if (limit < 1 || limit > MAX_LEDGER_LIMIT) throw ApiError.invalidInput(`limit deve ser um inteiro entre 1 e ${MAX_LEDGER_LIMIT}`);
  return limit;
}

/** Cursor = base64url de `v1:<seq>`. Ausente = início; qualquer outra coisa inválida = 400. */
function parseCursor(value: unknown): bigint {
  if (value === undefined) return 0n;
  if (typeof value !== 'string' || value.length > 64) throw ApiError.invalidInput('cursor inválido');
  const match = CURSOR_PATTERN.exec(Buffer.from(value, 'base64url').toString('utf8'));
  const seq = match?.[1] === undefined ? undefined : BigInt(match[1]);
  if (seq === undefined || seq > MAX_SEQ || encodeCursor(seq.toString()) !== value) throw ApiError.invalidInput('cursor inválido');
  return seq;
}

function encodeCursor(seq: string): string {
  return Buffer.from(`v1:${seq}`, 'utf8').toString('base64url');
}

/** Campos ausentes saem sempre como `null`. */
function transactionBody(row: WagerTransactionRecord): Record<string, unknown> {
  return {
    transactionId: row.id,
    providerId: row.providerId,
    externalTransactionId: row.externalTransactionId,
    walletId: row.walletId,
    playerId: row.playerId,
    roundId: row.roundId,
    gameId: row.gameId,
    kind: row.kind,
    status: row.status,
    money: { amount: row.amount, currency: row.currency },
    referenceExternalTransactionId: row.referenceExternalTransactionId,
    referenceTransactionId: row.referenceTransactionId,
    failureCode: row.failureCode,
    balance: row.observedBalance === null ? null : { amount: row.observedBalance, currency: row.currency },
    nextReferenceCheckAt: row.nextReferenceCheckAt,
    createdAt: row.createdAt,
    processedAt: row.processedAt,
  };
}
