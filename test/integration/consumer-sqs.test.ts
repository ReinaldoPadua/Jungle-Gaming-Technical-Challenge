/**
 * Consumidor contra SQS FIFO real (LocalStack). Requer `bun run infra:up`.
 * Pulada com aviso se o SQS não estiver acessível.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { SendMessageCommand, type SQSClient } from '@aws-sdk/client-sqs';
import type { MikroORM } from '@mikro-orm/postgresql';
import { resolveQueueUrls, type QueueUrls } from '../../src/infrastructure/messaging/sqs';
import { SqsQueueClient } from '../../src/modules/messaging/infrastructure/sqs/sqs-queue-client';
import { initOrm, sqsClient, testEnv } from '../helpers/infra';
import { migrateFresh, truncateAll } from '../helpers/db';
import { startHttpApp, type HttpTestApp } from '../helpers/http-app';
import { buildConsumer, wagerMessage } from '../helpers/consumer';
import { drainQueue, sqsAvailable } from '../helpers/sqs';
import { assertAllWalletsConsistent, createWallet, type TestWallet } from '../helpers/wager';

const sqs: SQSClient = sqsClient();
const available = await sqsAvailable(sqs, testEnv.WAGER_QUEUE_NAME);
if (!available) console.warn('[consumer-sqs] SQS indisponível — suíte PULADA. Rode `bun run infra:up` para executá-la.');

describe.skipIf(!available)('consumidor ← SQS FIFO (LocalStack)', () => {
  let orm: MikroORM;
  let http: HttpTestApp;
  let queues: QueueUrls;
  const send = (body: unknown, groupId: string, dedupId = crypto.randomUUID()) =>
    sqs.send(new SendMessageCommand({ QueueUrl: queues.wager, MessageBody: typeof body === 'string' ? body : JSON.stringify(body), MessageGroupId: groupId, MessageDeduplicationId: dedupId }));
  const balance = async (w: TestWallet) => (await http.get(`/wallets/${w.walletId}`)).body.balance.amount as string;
  const client = () => new SqsQueueClient(sqs, queues.wager, queues.wagerDlq);

  beforeAll(async () => {
    orm = await initOrm();
    await migrateFresh(orm);
    http = await startHttpApp();
    queues = await resolveQueueUrls(sqs, testEnv);
  });
  afterAll(async () => {
    await http?.close();
    await orm?.close(true);
  });
  beforeEach(async () => {
    await truncateAll(orm);
    await drainQueue(sqs, queues.wager, { idleMs: 300 });
    await drainQueue(sqs, queues.wagerDlq, { idleMs: 300 });
  });

  test('mensagem válida é processada e removida da fila', async () => {
    const w = await createWallet(http, '100.00');
    await send(wagerMessage(w, { kind: 'BET', amount: '25.00' }), w.walletId);
    const { consumer } = buildConsumer(orm, client(), { config: { waitSeconds: 2, visibilityTimeoutSeconds: 5 } });
    expect(await consumer.pollOnce()).toBe(1);
    expect(await balance(w)).toBe('75.00');
    expect(await drainQueue(sqs, queues.wager, { idleMs: 500 })).toHaveLength(0);
    await assertAllWalletsConsistent(orm);
  }, 60_000);

  test('mensagem venenosa vai para a DLQ com o motivo nos atributos', async () => {
    await send('{not json', 'poison');
    const { consumer } = buildConsumer(orm, client(), { config: { waitSeconds: 2 } });
    await consumer.pollOnce();
    const dead = await drainQueue(sqs, queues.wagerDlq, { expected: 1 });
    expect(dead).toHaveLength(1);
    expect(dead[0]!.MessageAttributes?.failureReason?.StringValue).toBe('MALFORMED_JSON');
    expect(dead[0]!.Body).toBe('{not json');
  }, 60_000);

  test('worker morto entre o commit e o ack (processo real) → redelivery → um único débito', async () => {
    const w = await createWallet(http, '100.00');
    await send(wagerMessage(w, { kind: 'BET', amount: '40.00' }), w.walletId);
    const run = (extra: Record<string, string> = {}) =>
      Bun.spawn(['bun', 'test/helpers/consumer-worker.ts'], {
        env: { ...process.env, CONSUMER_VISIBILITY_TIMEOUT_S: '2', ...extra },
        stdout: 'ignore',
        stderr: 'inherit',
      });
    expect(await run({ FAULTS: 'consumer:after-commit-before-ack' }).exited).toBe(137);
    expect(await balance(w)).toBe('60.00'); // commit confirmado, mensagem não removida
    expect(await run({ IDLE_POLLS: '4' }).exited).toBe(0); // reentrega após o visibility timeout
    expect(await balance(w)).toBe('60.00');
    const rows = (await orm.em.getConnection().execute(`select count(*)::text as n from wallet_ledger_entries where direction = 'DEBIT'`)) as { n: string }[];
    expect(rows[0]!.n).toBe('1');
    expect(await drainQueue(sqs, queues.wager, { idleMs: 500 })).toHaveLength(0);
    await assertAllWalletsConsistent(orm);
  }, 60_000);

  test('redrive policy: erro transitório persistente acaba na DLQ', async () => {
    const w = await createWallet(http, '100.00');
    await send(wagerMessage(w, { kind: 'BET', amount: '1.00' }), w.walletId);
    const failing = { run: () => Promise.reject(Object.assign(new Error('connection refused'), { code: 'ECONNREFUSED' })) };
    const { consumer } = buildConsumer(orm, client(), {
      uow: () => failing,
      config: { waitSeconds: 1, visibilityTimeoutSeconds: 1, maxReceives: 3, retryBaseSeconds: 0, retryMaxSeconds: 0 },
    });
    for (let i = 0; i < 8; i++) await consumer.pollOnce();
    const dead = await drainQueue(sqs, queues.wagerDlq, { expected: 1 });
    expect(dead).toHaveLength(1);
    expect(dead[0]!.MessageAttributes?.failureReason?.StringValue).toBe('MAX_RECEIVES_EXCEEDED');
    expect(await balance(w)).toBe('100.00');
  }, 60_000);
});
