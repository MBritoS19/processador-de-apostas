import { SQSClient } from '@aws-sdk/client-sqs';
import type { AppConfig } from '../config/app-config';

export function createSqsClient(config: Pick<AppConfig, 'aws'>): SQSClient {
  const { region, endpointUrl, accessKeyId, secretAccessKey } = config.aws;
  return new SQSClient({
    region,
    ...(endpointUrl ? { endpoint: endpointUrl } : {}),
    ...(accessKeyId && secretAccessKey ? { credentials: { accessKeyId, secretAccessKey } } : {}),
  });
}
