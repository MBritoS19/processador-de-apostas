import { EntitySchema } from '@mikro-orm/core';
import type { InboxMessage } from '../../domain/inbox-message';
import type { OutboxMessage } from '../../domain/outbox-message';

/**
 * Linha de `inbox_messages`: chave primária (consumer_name, message_id). Inbox e outbox só têm o
 * mapeador de escrita: a inbox é lida só pelo hash (`InboxLookup`) e a outbox pelo `OutboxStore`.
 */
export class InboxMessageRecord {
  consumerName!: string;
  messageId!: string;
  payloadHash!: string;
  receivedAt!: Date;
  processedAt!: Date | null;
}

export const InboxMessageSchema = new EntitySchema<InboxMessageRecord>({
  class: InboxMessageRecord,
  tableName: 'inbox_messages',
  properties: {
    consumerName: { type: 'text', primary: true },
    messageId: { type: 'text', primary: true },
    payloadHash: { type: 'text' },
    receivedAt: { type: 'Date' },
    processedAt: { type: 'Date', nullable: true },
  },
});

export function toInboxMessageRecord(message: InboxMessage): InboxMessageRecord {
  return Object.assign(new InboxMessageRecord(), {
    consumerName: message.consumerName,
    messageId: message.messageId,
    payloadHash: message.payloadHash,
    receivedAt: message.receivedAt,
    processedAt: message.processedAt ?? null,
  });
}

/** Linha de `outbox_messages`. `payload` é o envelope do evento, em jsonb. */
export class OutboxMessageRecord {
  id!: string;
  aggregateId!: string;
  eventType!: string;
  payload!: Record<string, unknown>;
  occurredAt!: Date;
  attempts!: number;
  nextAttemptAt!: Date | null;
  publishedAt!: Date | null;
}

export const OutboxMessageSchema = new EntitySchema<OutboxMessageRecord>({
  class: OutboxMessageRecord,
  tableName: 'outbox_messages',
  properties: {
    id: { type: 'uuid', primary: true },
    aggregateId: { type: 'uuid' },
    eventType: { type: 'text' },
    payload: { type: 'json' },
    occurredAt: { type: 'Date' },
    attempts: { type: 'integer' },
    nextAttemptAt: { type: 'Date', nullable: true },
    publishedAt: { type: 'Date', nullable: true },
  },
});

export function toOutboxMessageRecord(message: OutboxMessage): OutboxMessageRecord {
  return Object.assign(new OutboxMessageRecord(), {
    id: message.id,
    aggregateId: message.aggregateId,
    eventType: message.eventType,
    payload: { ...message.payload },
    occurredAt: message.occurredAt,
    attempts: message.attempts,
    nextAttemptAt: message.nextAttemptAt ?? null,
    publishedAt: message.publishedAt ?? null,
  });
}
