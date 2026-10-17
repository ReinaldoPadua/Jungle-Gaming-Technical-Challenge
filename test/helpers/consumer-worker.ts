/**
 * Processo consumidor isolado (SQS real) para testes de crash.
 * Consome até a fila ficar ociosa por IDLE_POLLS ciclos e sai com 0.
 * Com FAULTS=consumer:after-commit-before-ack, sai com 137 logo após o 1º commit.
 */
import 'reflect-metadata';
import { MikroORM } from '@mikro-orm/postgresql';
import { loadEnv } from '../../src/config/env';
import { buildOrmConfig } from '../../src/infrastructure/database/mikro-orm.config';
import { MikroUnitOfWork } from '../../src/infrastructure/database/mikro-unit-of-work';
import { createSqsClient, resolveQueueUrls } from '../../src/infrastructure/messaging/sqs';
import { SqsQueueClient } from '../../src/modules/messaging/infrastructure/sqs/sqs-queue-client';
import { ProcessWagerTransactionUseCase } from '../../src/modules/wagering/application/process-wager-transaction.use-case';
import { DEFAULT_REFERENCE_RETRY_POLICY } from '../../src/modules/wagering/domain/reference-retry-policy';
import { WagerConsumer } from '../../src/modules/wagering/interface/sqs/wager-consumer';
import { consumerConfigFromEnv } from '../../src/modules/wagering/wager-consumer.module';
import { systemClock } from '../../src/shared/application/clock';
import { faultsFromEnv } from '../../src/shared/application/faults';
import { uuidV7Generator } from '../../src/shared/application/id-generator';
import { jsonLogger } from '../../src/shared/application/logger';
import { noopMetrics } from '../../src/shared/application/metrics';

const env = loadEnv();
const orm = await MikroORM.init(buildOrmConfig(env));
const sqs = createSqsClient(env);
const queues = await resolveQueueUrls(sqs, env);
const useCase = new ProcessWagerTransactionUseCase(new MikroUnitOfWork(orm, noopMetrics), systemClock, uuidV7Generator, noopMetrics, DEFAULT_REFERENCE_RETRY_POLICY);
const consumer = new WagerConsumer(new SqsQueueClient(sqs, queues.wager, queues.wagerDlq), useCase, noopMetrics, jsonLogger, faultsFromEnv(process.env), {
  ...consumerConfigFromEnv(env),
  waitSeconds: 1,
});

const idlePolls = Number(process.env.IDLE_POLLS ?? 3);
let idle = 0;
const deadline = Date.now() + 25_000;
while (idle < idlePolls && Date.now() < deadline) {
  idle = (await consumer.pollOnce()) === 0 ? idle + 1 : 0;
}
await orm.close();
sqs.destroy();
process.exit(0);
