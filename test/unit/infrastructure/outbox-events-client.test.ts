import { describe, expect, it } from 'bun:test';
import { GetQueueUrlCommand, SendMessageBatchCommand, type SQSClient } from '@aws-sdk/client-sqs';
import { OutboxMessage } from '../../../src/domain/outbox-message';
import { OutboxEventsClient } from '../../../src/infrastructure/outbox/outbox-events.client';
import { errorPauseMs } from '../../../src/interfaces/error-pause';

function message(id: string, aggregateId = 'agg-1'): OutboxMessage {
  return OutboxMessage.rehydrate({
    id,
    aggregateId,
    eventType: 'WalletBalanceChanged',
    payload: { eventId: id, data: { walletVersion: 2 } },
    occurredAt: new Date('2026-11-07T12:00:00.000Z'),
    attempts: 0,
  });
}

/** SQSClient falso: responde GetQueueUrl e devolve `batchOutput` para o SendMessageBatch. */
function fakeSqs(batchOutput: object) {
  const sent: SendMessageBatchCommand[] = [];
  const sqs = {
    send: async (command: unknown) => {
      if (command instanceof GetQueueUrlCommand) return { QueueUrl: 'http://q/events.fifo' };
      if (command instanceof SendMessageBatchCommand) {
        sent.push(command);
        return batchOutput;
      }
      throw new Error('comando inesperado');
    },
  } as unknown as SQSClient;
  return { sqs, sent };
}

describe('OutboxEventsClient', () => {
  it('envia o envelope exato, grupo = aggregateId, dedup = eventId', async () => {
    const { sqs, sent } = fakeSqs({ Successful: [{ Id: '0' }, { Id: '1' }] });
    const client = new OutboxEventsClient(sqs, 'events.fifo');
    const result = await client.publish([message('e1', 'agg-1'), message('e2', 'agg-2')], new AbortController().signal);

    expect(sent[0]?.input.Entries).toEqual([
      { Id: '0', MessageBody: JSON.stringify({ eventId: 'e1', data: { walletVersion: 2 } }), MessageGroupId: 'agg-1', MessageDeduplicationId: 'e1' },
      { Id: '1', MessageBody: JSON.stringify({ eventId: 'e2', data: { walletVersion: 2 } }), MessageGroupId: 'agg-2', MessageDeduplicationId: 'e2' },
    ]);
    expect([...result.published]).toEqual(['e1', 'e2']);
    expect(result.failed.size).toBe(0);
  });

  it('falha parcial: mapeia cada entrada; entrada sem resposta conta como falha, nunca como publicada', async () => {
    const { sqs } = fakeSqs({ Successful: [{ Id: '0' }], Failed: [{ Id: '1', Code: 'InternalError', SenderFault: false }] });
    const client = new OutboxEventsClient(sqs, 'events.fifo');
    const result = await client.publish([message('e1'), message('e2'), message('e3')], new AbortController().signal);

    expect([...result.published]).toEqual(['e1']);
    expect(Object.fromEntries(result.failed)).toEqual({ e2: 'InternalError', e3: 'missing_result' });
  });
});

describe('errorPauseMs', () => {
  it('1s, 2s, 4s… até 30s', () => {
    expect([1, 2, 3, 5, 6, 100].map(errorPauseMs)).toEqual([1_000, 2_000, 4_000, 16_000, 30_000, 30_000]);
  });
});
