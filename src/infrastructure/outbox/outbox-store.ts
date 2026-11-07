import type { EntityManager } from '@mikro-orm/postgresql';
import { OutboxMessage } from '../../domain/outbox-message';

/**
 * Elegível = pendente, vencido e sem evento anterior (menor `seq`) pendente do mesmo agregado.
 * Um evento anterior travado por outro publisher, em backoff ou que falha para sempre bloqueia
 * os seguintes do agregado: dois publishers nunca publicam o mesmo agregado fora de ordem.
 */
const CLAIM_SQL = `
  select o.id, o.aggregate_id, o.event_type, o.payload, o.occurred_at, o.attempts, o.next_attempt_at
  from outbox_messages o
  where o.published_at is null
    and (o.next_attempt_at is null or o.next_attempt_at <= ?)
    and not exists (
      select 1 from outbox_messages p
      where p.aggregate_id = o.aggregate_id and p.published_at is null and p.seq < o.seq
    )
  order by o.seq
  limit ?
  for update of o skip locked`;

/** O driver (type parser do MikroORM) devolve timestamptz como texto; a conversão é explícita em `toMessage`. */
interface OutboxRow {
  id: string;
  aggregate_id: string;
  event_type: string;
  payload: Record<string, unknown>;
  occurred_at: string;
  attempts: number;
  next_attempt_at: string | null;
}

export interface OutboxBacklog {
  /** Agora menos o `occurred_at` do pendente mais antigo, em segundos (0 sem pendentes). */
  lagSeconds: number;
  /** Pendentes com `attempts >= stuckAttempts`. */
  stuck: number;
}

/**
 * Acesso SQL da outbox para o publisher. O claim e a gravação do resultado acontecem na
 * mesma transação curta: o lock da linha é segurado durante a publicação.
 */
export class OutboxStore {
  constructor(
    private readonly em: EntityManager,
    private readonly idleInTransactionTimeoutMs: number,
    private readonly statementTimeoutMs = 5_000,
  ) {
    for (const value of [idleInTransactionTimeoutMs, statementTimeoutMs]) {
      if (!Number.isInteger(value) || value <= 0) throw new RangeError('timeouts devem ser inteiros positivos');
    }
  }

  /**
   * Trava até `limit` eventos elegíveis, entrega-os a `work` (que os marca publicados ou
   * reagenda) e grava o estado no mesmo commit. Se algo lançar antes do commit, o lock cai
   * e outro publisher pega os eventos de novo (at-least-once). Devolve os eventos após o commit.
   */
  async claim(limit: number, now: Date, work: (messages: OutboxMessage[]) => Promise<void>): Promise<OutboxMessage[]> {
    return this.em.fork().transactional(async (em) => {
      // Inteiros validados no construtor: sem risco de injeção.
      await em.execute(`set local statement_timeout = '${this.statementTimeoutMs}ms'`);
      await em.execute(`set local idle_in_transaction_session_timeout = '${this.idleInTransactionTimeoutMs}ms'`);
      const rows = await em.execute<OutboxRow[]>(CLAIM_SQL, [now, limit]);
      const messages = rows.map(toMessage);
      if (messages.length === 0) return messages;
      await work(messages);
      await this.save(em, messages);
      return messages;
    });
  }

  /** Grava o resultado. Público só para os testes simularem a morte entre a publicação e o commit. */
  async save(em: EntityManager, messages: readonly OutboxMessage[]): Promise<void> {
    for (const message of messages) {
      const result = await em.execute(
        `update outbox_messages set published_at = ?, attempts = ?, next_attempt_at = ?
         where id = ? and published_at is null`,
        [message.publishedAt ?? null, message.attempts, message.nextAttemptAt ?? null, message.id],
        'run',
      );
      // Sob o lock, a linha não pode ter mudado. Se mudou, é bug: aborta (rollback) em vez de seguir.
      if ((result as { affectedRows?: number }).affectedRows !== 1) {
        throw new Error(`outbox ${message.id} não estava pendente ao gravar o resultado`);
      }
    }
  }

  async backlog(now: Date, stuckAttempts: number): Promise<OutboxBacklog> {
    const [row] = await this.em.fork().execute<Array<{ lag: string | null; stuck: string }>>(
      `select extract(epoch from (?::timestamptz - min(occurred_at)))::text as lag,
              count(*) filter (where attempts >= ?)::text as stuck
       from outbox_messages where published_at is null`,
      [now, stuckAttempts],
    );
    return { lagSeconds: Math.max(0, Number(row?.lag ?? 0)), stuck: Number(row?.stuck ?? 0) };
  }
}

function toMessage(row: OutboxRow): OutboxMessage {
  return OutboxMessage.rehydrate({
    id: row.id,
    aggregateId: row.aggregate_id,
    eventType: row.event_type,
    payload: row.payload,
    occurredAt: new Date(row.occurred_at),
    attempts: row.attempts,
    nextAttemptAt: row.next_attempt_at === null ? undefined : new Date(row.next_attempt_at),
  });
}
