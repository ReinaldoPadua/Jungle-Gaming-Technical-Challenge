import { SQSClient } from '@aws-sdk/client-sqs';
import { MikroORM } from '@mikro-orm/postgresql';
import { loadEnv } from '../../src/config/env';
import { buildOrmConfig } from '../../src/infrastructure/database/mikro-orm.config';
import { createSqsClient } from '../../src/infrastructure/messaging/sqs';

export const testEnv = loadEnv();

export function initOrm(): Promise<MikroORM> {
  return MikroORM.init(buildOrmConfig(testEnv));
}

export function sqsClient(): SQSClient {
  return createSqsClient(testEnv);
}

export const uniqueSuffix = () => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
