import type { SQSClient } from '@aws-sdk/client-sqs';
import { MikroORM } from '@mikro-orm/postgresql';
import { type BeforeApplicationShutdown, Inject, Module, type OnApplicationBootstrap } from '@nestjs/common';
import { ENV, type Env } from '../../config/env';
import { QUEUE_URLS, type QueueUrls, SQS_CLIENT } from '../../infrastructure/messaging/sqs';
import { CLOCK, type Clock } from '../../shared/application/clock';
import { FAULTS, type Faults } from '../../shared/application/faults';
import { APP_LOGGER, type AppLogger } from '../../shared/application/logger';
import { METRICS, type Metrics } from '../../shared/application/metrics';
import { DEFAULT_OUTBOX_PUBLISHER_CONFIG, OutboxPublisher } from './application/outbox-publisher';
import { EVENT_PUBLISHER, type EventPublisher, OUTBOX_STORE, type OutboxStore } from './application/ports';
import { MikroOutboxStore } from './infrastructure/persistence/mikro-outbox-store';
import { SqsEventPublisher } from './infrastructure/sqs/sqs-event-publisher';

export const OUTBOX_PUBLISHER = Symbol('OUTBOX_PUBLISHER');

@Module({
  providers: [
    { provide: OUTBOX_STORE, inject: [MikroORM], useFactory: (orm: MikroORM) => new MikroOutboxStore(orm) },
    {
      provide: EVENT_PUBLISHER,
      inject: [SQS_CLIENT, QUEUE_URLS],
      useFactory: (sqs: SQSClient, queues: QueueUrls) => new SqsEventPublisher(sqs, queues.events),
    },
    {
      provide: OUTBOX_PUBLISHER,
      inject: [OUTBOX_STORE, EVENT_PUBLISHER, CLOCK, METRICS, APP_LOGGER, FAULTS, ENV],
      useFactory: (store: OutboxStore, publisher: EventPublisher, clock: Clock, metrics: Metrics, logger: AppLogger, faults: Faults, env: Env) =>
        new OutboxPublisher(store, publisher, clock, metrics, logger, faults, {
          ...DEFAULT_OUTBOX_PUBLISHER_CONFIG,
          owner: env.INSTANCE_ID,
          batchSize: env.OUTBOX_BATCH_SIZE,
          leaseMs: env.OUTBOX_LEASE_MS,
          pollIntervalMs: env.OUTBOX_POLL_INTERVAL_MS,
        }),
    },
  ],
  exports: [OUTBOX_PUBLISHER],
})
export class OutboxModule implements OnApplicationBootstrap, BeforeApplicationShutdown {
  constructor(
    @Inject(OUTBOX_PUBLISHER) private readonly publisher: OutboxPublisher,
    @Inject(ENV) private readonly env: Env,
  ) {}

  onApplicationBootstrap(): void {
    if (this.env.OUTBOX_PUBLISHER_ENABLED) this.publisher.start();
  }

  /** SIGTERM: termina o ciclo em andamento; leases pendentes expiram e outra instância assume. */
  async beforeApplicationShutdown(): Promise<void> {
    await this.publisher.stop();
  }
}
