import type { SQSClient } from '@aws-sdk/client-sqs';
import { type BeforeApplicationShutdown, Inject, Module, type OnApplicationBootstrap } from '@nestjs/common';
import { ENV, type Env } from '../../config/env';
import { QUEUE_URLS, type QueueUrls, SQS_CLIENT } from '../../infrastructure/messaging/sqs';
import { FAULTS, type Faults } from '../../shared/application/faults';
import { APP_LOGGER, type AppLogger } from '../../shared/application/logger';
import { METRICS, type Metrics } from '../../shared/application/metrics';
import { QUEUE_CLIENT, type QueueClient } from '../messaging/application/queue';
import { SqsQueueClient } from '../messaging/infrastructure/sqs/sqs-queue-client';
import type { ProcessWagerTransactionUseCase } from './application/process-wager-transaction.use-case';
import { WagerConsumer } from './interface/sqs/wager-consumer';
import { WageringModule } from './wagering.module';
import { PROCESS_WAGER } from './wagering.tokens';

export const WAGER_CONSUMER = Symbol('WAGER_CONSUMER');

export function consumerConfigFromEnv(env: Env) {
  return {
    consumerName: env.CONSUMER_NAME,
    batchSize: env.CONSUMER_BATCH_SIZE,
    waitSeconds: env.CONSUMER_WAIT_TIME_S,
    visibilityTimeoutSeconds: env.CONSUMER_VISIBILITY_TIMEOUT_S,
    maxReceives: env.CONSUMER_MAX_RECEIVES,
    retryBaseSeconds: env.CONSUMER_RETRY_BASE_S,
    retryMaxSeconds: env.CONSUMER_RETRY_MAX_S,
    shutdownGraceMs: env.CONSUMER_SHUTDOWN_GRACE_MS,
  };
}

@Module({
  imports: [WageringModule],
  providers: [
    {
      provide: QUEUE_CLIENT,
      inject: [SQS_CLIENT, QUEUE_URLS],
      useFactory: (sqs: SQSClient, q: QueueUrls) => new SqsQueueClient(sqs, q.wager, q.wagerDlq),
    },
    {
      provide: WAGER_CONSUMER,
      inject: [QUEUE_CLIENT, PROCESS_WAGER, METRICS, APP_LOGGER, FAULTS, ENV],
      useFactory: (queue: QueueClient, useCase: ProcessWagerTransactionUseCase, metrics: Metrics, logger: AppLogger, faults: Faults, env: Env) =>
        new WagerConsumer(queue, useCase, metrics, logger, faults, consumerConfigFromEnv(env)),
    },
  ],
})
export class WagerConsumerModule implements OnApplicationBootstrap, BeforeApplicationShutdown {
  constructor(
    @Inject(WAGER_CONSUMER) private readonly consumer: WagerConsumer,
    @Inject(ENV) private readonly env: Env,
  ) {}

  onApplicationBootstrap(): void {
    if (this.env.CONSUMER_ENABLED) this.consumer.start();
  }

  /** Antes do ORM fechar: conclui as mensagens em andamento e devolve as não iniciadas. */
  async beforeApplicationShutdown(): Promise<void> {
    await this.consumer.stop();
  }
}
