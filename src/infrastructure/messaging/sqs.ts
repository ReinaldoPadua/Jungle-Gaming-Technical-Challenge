import { GetQueueUrlCommand, SQSClient } from '@aws-sdk/client-sqs';
import type { Env } from '../../config/env';

export const SQS_CLIENT = Symbol('SQS_CLIENT');
export const QUEUE_URLS = Symbol('QUEUE_URLS');

export interface QueueUrls {
  readonly wager: string;
  readonly wagerDlq: string;
  readonly events: string;
}

export function createSqsClient(env: Env): SQSClient {
  return new SQSClient({
    region: env.AWS_REGION,
    endpoint: env.SQS_ENDPOINT,
    credentials: { accessKeyId: env.AWS_ACCESS_KEY_ID, secretAccessKey: env.AWS_SECRET_ACCESS_KEY },
    // A LocalStack devolve QueueUrl com o hostname interno do container; sem isto
    // o SDK usaria esse host como endpoint e falharia quando rodando fora do compose.
    useQueueUrlAsEndpoint: false,
    maxAttempts: 3,
  });
}

export async function resolveQueueUrls(client: SQSClient, env: Env): Promise<QueueUrls> {
  const url = async (QueueName: string): Promise<string> => {
    const { QueueUrl } = await client.send(new GetQueueUrlCommand({ QueueName }));
    if (!QueueUrl) throw new Error(`SQS queue not found: ${QueueName}`);
    return QueueUrl;
  };
  const [wager, wagerDlq, events] = await Promise.all([
    url(env.WAGER_QUEUE_NAME),
    url(env.WAGER_DLQ_NAME),
    url(env.EVENTS_QUEUE_NAME),
  ]);
  return { wager, wagerDlq, events };
}
