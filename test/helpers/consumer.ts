import type { MikroORM } from '@mikro-orm/postgresql';
import { MikroUnitOfWork } from '../../src/infrastructure/database/mikro-unit-of-work';
import { PromMetrics } from '../../src/infrastructure/observability/prom-metrics';
import type { QueueClient } from '../../src/modules/messaging/application/queue';
import { ProcessWagerTransactionUseCase } from '../../src/modules/wagering/application/process-wager-transaction.use-case';
import { DEFAULT_REFERENCE_RETRY_POLICY } from '../../src/modules/wagering/domain/reference-retry-policy';
import { WagerConsumer, type WagerConsumerConfig } from '../../src/modules/wagering/interface/sqs/wager-consumer';
import { systemClock } from '../../src/shared/application/clock';
import { noFaults, type Faults } from '../../src/shared/application/faults';
import { uuidV7Generator } from '../../src/shared/application/id-generator';
import type { AppLogger } from '../../src/shared/application/logger';
import type { UnitOfWork } from '../../src/shared/application/unit-of-work';
import { uuid } from './db';
import type { TestWallet, WagerInput } from './wager';
import { wagerBody } from './wager';

export const quietLogger: AppLogger = { info: () => {}, warn: () => {}, error: () => {} };

export const TEST_CONSUMER_CONFIG: WagerConsumerConfig = {
  consumerName: 'wager-transactions-consumer',
  batchSize: 10,
  waitSeconds: 0,
  visibilityTimeoutSeconds: 30,
  maxReceives: 5,
  retryBaseSeconds: 0,
  retryMaxSeconds: 0,
  shutdownGraceMs: 5_000,
};

export function buildConsumer(
  orm: MikroORM,
  queue: QueueClient,
  opts: { uow?: (real: UnitOfWork) => UnitOfWork; faults?: Faults; metrics?: PromMetrics; config?: Partial<WagerConsumerConfig> } = {},
) {
  const metrics = opts.metrics ?? new PromMetrics();
  const realUow = new MikroUnitOfWork(orm, metrics);
  const useCase = new ProcessWagerTransactionUseCase(
    opts.uow ? opts.uow(realUow) : realUow,
    systemClock,
    uuidV7Generator,
    metrics,
    DEFAULT_REFERENCE_RETRY_POLICY,
  );
  const consumer = new WagerConsumer(queue, useCase, metrics, quietLogger, opts.faults ?? noFaults, {
    ...TEST_CONSUMER_CONFIG,
    ...opts.config,
  });
  return { consumer, useCase, metrics };
}

/** Envelope `WagerTransactionRequested` para uma operação. */
export function wagerMessage(w: TestWallet, input: WagerInput, messageId = `msg-${uuid()}`) {
  const { body, idempotencyKey } = wagerBody(w, input);
  return {
    messageId,
    type: 'WagerTransactionRequested',
    occurredAt: new Date().toISOString(),
    data: { ...body, idempotencyKey },
  };
}

/** Executa ciclos até a fila esvaziar (ou o limite de ciclos). */
export async function drainConsumers(queue: { pending: number; expireVisibility(): void }, consumers: WagerConsumer[], maxCycles = 50) {
  for (let i = 0; i < maxCycles && queue.pending > 0; i++) {
    const handled = await Promise.all(consumers.map((c) => c.pollOnce()));
    if (handled.every((n) => n === 0)) queue.expireVisibility();
  }
}
