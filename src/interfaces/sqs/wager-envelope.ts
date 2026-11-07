import { createHash } from 'node:crypto';
import { canonicalJson } from '../../application/wagering/payload-hash';
import { textProblem, type WagerTransactionPayload } from '../../application/wagering/process-wager-transaction';
import { CORRELATION_ID_PATTERN } from '../../infrastructure/observability/correlation';

export const WAGER_MESSAGE_TYPE = 'WagerTransactionRequested';

/** ISO 8601 com data, hora e fuso (Z ou ±hh:mm). */
const ISO_DATE_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,9})?(Z|[+-]\d{2}:\d{2})$/;

export interface WagerEnvelope {
  messageId: string;
  idempotencyKey: string;
  /** Validado pelo use case (o mesmo validador da entrada HTTP). */
  data: WagerTransactionPayload;
  /** SHA-256 hex do JSON canônico de `{ type, data }`: sem messageId, occurredAt nem metadados. */
  payloadHash: string;
  /** `correlationId` do envelope, se válido; senão o messageId. */
  correlationId: string;
}

type Json = Parameters<typeof canonicalJson>[0];

/**
 * Valida o envelope do CHALLENGE §10. Devolve o envelope ou o motivo (texto sem valores do
 * payload). Os campos de negócio de `data` ficam para o use case.
 */
export function parseEnvelope(body: string): WagerEnvelope | string {
  let value: unknown;
  try {
    value = JSON.parse(body);
  } catch {
    return 'corpo não é JSON';
  }
  if (!isObject(value)) return 'envelope deve ser um objeto';
  const messageIdProblem = textProblem('messageId', value.messageId);
  if (messageIdProblem) return messageIdProblem;
  if (value.type !== WAGER_MESSAGE_TYPE) return `type deve ser ${WAGER_MESSAGE_TYPE}`;
  if (typeof value.occurredAt !== 'string' || !ISO_DATE_TIME.test(value.occurredAt) || Number.isNaN(Date.parse(value.occurredAt))) {
    return 'occurredAt deve ser uma data ISO 8601';
  }
  const { data } = value;
  if (!isObject(data)) return 'data deve ser um objeto';
  const keyProblem = textProblem('data.idempotencyKey', data.idempotencyKey);
  if (keyProblem) return keyProblem;

  const messageId = value.messageId as string;
  const correlationId =
    typeof value.correlationId === 'string' && CORRELATION_ID_PATTERN.test(value.correlationId) ? value.correlationId : messageId;
  return {
    messageId,
    idempotencyKey: data.idempotencyKey as string,
    data: data as unknown as WagerTransactionPayload,
    payloadHash: createHash('sha256')
      .update(canonicalJson({ type: WAGER_MESSAGE_TYPE, data: data as Json }), 'utf8')
      .digest('hex'),
    correlationId,
  };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
