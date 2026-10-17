/**
 * Processo de publisher isolado para testes de crash real.
 * Uso: OUTBOX_TEST_PUBLISHER=file:<path>|sqs WORKER_NAME=a [FAULTS=outbox:after-publish] bun test/helpers/outbox-worker.ts
 * Drena a outbox e sai com 0; com a falha armada, sai com 137 logo após publicar.
 */
import 'reflect-metadata';
import { MikroORM } from '@mikro-orm/postgresql';
import { loadEnv } from '../../src/config/env';
import { buildOrmConfig } from '../../src/infrastructure/database/mikro-orm.config';
import { createSqsClient, resolveQueueUrls } from '../../src/infrastructure/messaging/sqs';
import { DEFAULT_OUTBOX_PUBLISHER_CONFIG, OutboxPublisher } from '../../src/modules/messaging/application/outbox-publisher';
import type { EventPublisher } from '../../src/modules/messaging/application/ports';
import { MikroOutboxStore } from '../../src/modules/messaging/infrastructure/persistence/mikro-outbox-store';
import { SqsEventPublisher } from '../../src/modules/messaging/infrastructure/sqs/sqs-event-publisher';
import { systemClock } from '../../src/shared/application/clock';
import { faultsFromEnv } from '../../src/shared/application/faults';
import { JsonLogger } from '../../src/infrastructure/observability/json-logger';
const jsonLogger = new JsonLogger({ level: 'warn', service: 'test-worker' });
import { noopMetrics } from '../../src/shared/application/metrics';
import { FilePublisher } from './outbox';

const env = loadEnv();
const orm = await MikroORM.init(buildOrmConfig(env));
const name = process.env.WORKER_NAME ?? 'worker';
const target = process.env.OUTBOX_TEST_PUBLISHER ?? 'sqs';

let publisher: EventPublisher;
if (target.startsWith('file:')) publisher = new FilePublisher(target.slice(5), name);
else {
  const sqs = createSqsClient(env);
  publisher = new SqsEventPublisher(sqs, (await resolveQueueUrls(sqs, env)).events);
}

const worker = new OutboxPublisher(new MikroOutboxStore(orm), publisher, systemClock, noopMetrics, jsonLogger, faultsFromEnv(process.env), {
  ...DEFAULT_OUTBOX_PUBLISHER_CONFIG,
  owner: name,
  batchSize: Number(process.env.OUTBOX_BATCH_SIZE ?? 10),
  leaseMs: Number(process.env.OUTBOX_LEASE_MS ?? 500),
});

// drena: continua enquanto houver trabalho ou leases de outros ainda por expirar
const deadline = Date.now() + 15_000;
while (Date.now() < deadline) {
  const handled = await worker.runOnce();
  if (handled === 0) {
    const { pending } = await new MikroOutboxStore(orm).stats(new Date());
    if (pending === 0) break;
    await Bun.sleep(100);
  }
}
await orm.close();
process.exit(0);
