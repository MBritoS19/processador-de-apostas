import { SQSClient, type SQSClientConfig } from '@aws-sdk/client-sqs';
import type { AppConfig } from '../config/app-config';

/** `overrides` permite clientes com política própria (ex.: o outbox publisher, sem retries do SDK). */
export function createSqsClient(config: Pick<AppConfig, 'aws'>, overrides: SQSClientConfig = {}): SQSClient {
  const { region, endpointUrl, accessKeyId, secretAccessKey } = config.aws;
  return new SQSClient({
    region,
    ...(endpointUrl ? { endpoint: endpointUrl } : {}),
    ...(accessKeyId && secretAccessKey ? { credentials: { accessKeyId, secretAccessKey } } : {}),
    ...overrides,
  });
}
