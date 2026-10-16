/**
 * Outbox → SQS FIFO real (LocalStack). Requer `bun run infra:up`.
 * Se o SQS não estiver acessível, a suíte é pulada com aviso explícito.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import type { SQSClient } from '@aws-sdk/client-sqs';
import type { MikroORM } from '@mikro-orm/postgresql';
import { resolveQueueUrls } from '../../src/infrastructure/messaging/sqs';
import { PromMetrics } from '../../src/infrastructure/observability/prom-metrics';
import { DEFAULT_OUTBOX_PUBLISHER_CONFIG, OutboxPublisher } from '../../src/modules/messaging/application/outbox-publisher';
import { OutboxMessage } from '../../src/modules/messaging/domain/outbox-message';
import { MikroOutboxStore } from '../../src/modules/messaging/infrastructure/persistence/mikro-outbox-store';
import { SqsEventPublisher } from '../../src/modules/messaging/infrastructure/sqs/sqs-event-publisher';
import { systemClock } from '../../src/shared/application/clock';
import { noFaults } from '../../src/shared/application/faults';
import { initOrm, sqsClient, testEnv } from '../helpers/infra';
import { migrateFresh, truncateAll } from '../helpers/db';
import { seedOutbox, TestEvent } from '../helpers/outbox';
import { drainQueue, sqsAvailable } from '../helpers/sqs';

const sqs: SQSClient = sqsClient();
const available = await sqsAvailable(sqs, testEnv.EVENTS_QUEUE_NAME);
if (!available) console.warn('[outbox-sqs] SQS indisponível — suíte PULADA. Rode `bun run infra:up` para executá-la.');

describe.skipIf(!available)('outbox → SQS FIFO (LocalStack)', () => {
  let orm: MikroORM;
  let eventsUrl: string;
  const quiet = { info: () => {}, warn: () => {}, error: () => {} };
  const worker = (owner = 'w') =>
    new OutboxPublisher(new MikroOutboxStore(orm), new SqsEventPublisher(sqs, eventsUrl), systemClock, new PromMetrics(), quiet, noFaults, {
      ...DEFAULT_OUTBOX_PUBLISHER_CONFIG, owner, statsIntervalMs: 0,
    });

  beforeAll(async () => {
    orm = await initOrm();
    await migrateFresh(orm);
    eventsUrl = (await resolveQueueUrls(sqs, testEnv)).events;
  });
  afterAll(async () => {
    await orm?.close(true);
  });
  beforeEach(async () => {
    await truncateAll(orm);
    // drena em vez de PurgeQueue (limite de 1 purge/60 s por fila)
    await drainQueue(sqs, eventsUrl, { idleMs: 300 });
  });

  test('envelope publicado com MessageGroupId = aggregateId e dedup id = eventId; ordem preservada por grupo', async () => {
    const ids = await seedOutbox(orm, 12, { aggregates: 3 });
    expect(await worker().runOnce()).toBe(12);
    const received = await drainQueue(sqs, eventsUrl, { expected: 12 });
    expect(received).toHaveLength(12);
    const bodies = received.map((m) => JSON.parse(m.Body!));
    expect(new Set(bodies.map((b) => b.eventId))).toEqual(new Set(ids));
    for (const m of received) {
      const body = JSON.parse(m.Body!);
      expect(m.Attributes?.MessageGroupId).toBe(body.aggregateId);
      expect(m.Attributes?.MessageDeduplicationId).toBe(body.eventId);
      expect(m.MessageAttributes?.eventType?.StringValue).toBe('TestEvent');
    }
    // dentro de cada grupo, a sequência de ocorrência é mantida
    for (const agg of ['agg-0', 'agg-1', 'agg-2']) {
      const seqs = bodies.filter((b) => b.aggregateId === agg).map((b) => Number(b.data.seq));
      expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
    }
  });

  test('republicação do mesmo eventId é descartada pelo SQS FIFO (janela de dedup)', async () => {
    const message = OutboxMessage.enqueue(TestEvent.make('agg', 1));
    const publisher = new SqsEventPublisher(sqs, eventsUrl);
    expect((await publisher.publish([message]))[0]!.ok).toBe(true);
    expect((await publisher.publish([message]))[0]!.ok).toBe(true);
    expect(await drainQueue(sqs, eventsUrl, { expected: 1 })).toHaveLength(1);
  });

  test('crash real após publicar e antes de marcar → outra instância assume; consumidor recebe cada evento uma vez', async () => {
    const ids = await seedOutbox(orm, 25);
    const run = (name: string, extra: Record<string, string> = {}) =>
      Bun.spawn(['bun', 'test/helpers/outbox-worker.ts'], {
        env: { ...process.env, WORKER_NAME: name, OUTBOX_TEST_PUBLISHER: 'sqs', OUTBOX_LEASE_MS: '500', ...extra },
        stdout: 'ignore',
        stderr: 'inherit',
      });
    expect(await run('a', { FAULTS: 'outbox:after-publish', OUTBOX_BATCH_SIZE: '10' }).exited).toBe(137);
    expect(await run('b').exited).toBe(0);
    const received = await drainQueue(sqs, eventsUrl, { expected: 25 });
    const eventIds = received.map((m) => JSON.parse(m.Body!).eventId);
    expect(new Set(eventIds)).toEqual(new Set(ids)); // nenhum perdido
    expect(eventIds).toHaveLength(25); // republicações dos 10 primeiros deduplicadas pelo broker
  });
});
