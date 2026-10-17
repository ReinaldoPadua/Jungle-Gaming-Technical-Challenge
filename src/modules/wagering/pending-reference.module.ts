import { type BeforeApplicationShutdown, Inject, Module, type OnApplicationBootstrap } from '@nestjs/common';
import { ENV, type Env } from '../../config/env';
import { CLOCK, type Clock } from '../../shared/application/clock';
import { ID_GENERATOR, type IdGenerator } from '../../shared/application/id-generator';
import { APP_LOGGER, type AppLogger } from '../../shared/application/logger';
import { METRICS, type Metrics } from '../../shared/application/metrics';
import { UNIT_OF_WORK, type UnitOfWork } from '../../shared/application/unit-of-work';
import { PendingReferenceWorker } from './application/pending-reference.worker';
import type { ReferenceRetryPolicy } from './domain/reference-retry-policy';
import { WageringModule } from './wagering.module';
import { REFERENCE_RETRY_POLICY } from './wagering.tokens';

export const PENDING_REFERENCE_WORKER = Symbol('PENDING_REFERENCE_WORKER');

@Module({
  imports: [WageringModule],
  providers: [
    {
      provide: PENDING_REFERENCE_WORKER,
      inject: [UNIT_OF_WORK, CLOCK, ID_GENERATOR, METRICS, APP_LOGGER, REFERENCE_RETRY_POLICY, ENV],
      useFactory: (uow: UnitOfWork, clock: Clock, ids: IdGenerator, metrics: Metrics, logger: AppLogger, policy: ReferenceRetryPolicy, env: Env) =>
        new PendingReferenceWorker(uow, clock, ids, metrics, logger, policy, {
          batchSize: env.PENDING_WORKER_BATCH_SIZE,
          concurrency: env.PENDING_WORKER_CONCURRENCY,
          pollIntervalMs: env.PENDING_WORKER_POLL_INTERVAL_MS,
        }),
    },
  ],
})
export class PendingReferenceModule implements OnApplicationBootstrap, BeforeApplicationShutdown {
  constructor(
    @Inject(PENDING_REFERENCE_WORKER) private readonly worker: PendingReferenceWorker,
    @Inject(ENV) private readonly env: Env,
  ) {}

  onApplicationBootstrap(): void {
    if (this.env.PENDING_WORKER_ENABLED) this.worker.start();
  }

  async beforeApplicationShutdown(): Promise<void> {
    await this.worker.stop();
  }
}
