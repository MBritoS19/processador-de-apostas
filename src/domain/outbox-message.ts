import { addMs, exponentialBackoffMs } from './backoff';
import { InvalidMessageStateError } from './errors';
import type { IntegrationEvent } from './events/integration-event';

export const OUTBOX_RETRY_BASE_MS = 1_000;
export const OUTBOX_RETRY_MAX_MS = 5 * 60_000;

export interface OutboxMessageState {
  id: string;
  aggregateId: string;
  eventType: string;
  payload: Readonly<Record<string, unknown>>;
  occurredAt: Date;
  attempts: number;
  nextAttemptAt?: Date | undefined;
  publishedAt?: Date | undefined;
}

export class OutboxMessage {
  private constructor(
    readonly id: string,
    readonly aggregateId: string,
    readonly eventType: string,
    readonly payload: Readonly<Record<string, unknown>>,
    readonly occurredAt: Date,
    private _attempts: number,
    private _nextAttemptAt: Date | undefined,
    private _publishedAt: Date | undefined,
  ) {}

  /** O id da mensagem é o eventId: publicações duplicadas carregam o mesmo id para o consumidor deduplicar. */
  static enqueue(event: IntegrationEvent<object>): OutboxMessage {
    return new OutboxMessage(
      event.eventId,
      event.aggregateId,
      event.eventType,
      Object.freeze(event.toJSON()),
      event.occurredAt,
      0,
      undefined,
      undefined,
    );
  }

  static rehydrate(state: OutboxMessageState): OutboxMessage {
    return new OutboxMessage(
      state.id,
      state.aggregateId,
      state.eventType,
      state.payload,
      new Date(state.occurredAt),
      state.attempts,
      state.nextAttemptAt && new Date(state.nextAttemptAt),
      state.publishedAt && new Date(state.publishedAt),
    );
  }

  get attempts(): number {
    return this._attempts;
  }

  get nextAttemptAt(): Date | undefined {
    return this._nextAttemptAt;
  }

  get publishedAt(): Date | undefined {
    return this._publishedAt;
  }

  isPending(): boolean {
    return this._publishedAt === undefined;
  }

  isDue(now: Date): boolean {
    return this.isPending() && (this._nextAttemptAt === undefined || this._nextAttemptAt <= now);
  }

  markPublished(at: Date): void {
    this.assertPending();
    this._publishedAt = at;
    this._nextAttemptAt = undefined;
  }

  /** Incrementa attempts e agenda a próxima tentativa: 1s, 2s, 4s… até o teto de 5 min. */
  scheduleRetry(now: Date): void {
    this.assertPending();
    this._attempts += 1;
    this._nextAttemptAt = addMs(now, exponentialBackoffMs(this._attempts, OUTBOX_RETRY_BASE_MS, OUTBOX_RETRY_MAX_MS));
  }

  private assertPending(): void {
    if (!this.isPending()) {
      throw new InvalidMessageStateError(`outbox ${this.id} já foi publicada`);
    }
  }
}
