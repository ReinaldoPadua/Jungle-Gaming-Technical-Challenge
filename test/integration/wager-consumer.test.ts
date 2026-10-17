/**
 * Consumidor SQS contra PostgreSQL real. A fila é uma FIFO em memória que emula
 * visibility timeout, ordem por grupo e redrive (o caminho com SQS real está em
 * consumer-sqs.test.ts).
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import type { MikroORM } from '@mikro-orm/postgresql';
import { TransientError } from '../../src/shared/application/errors';
import type { UnitOfWork } from '../../src/shared/application/unit-of-work';
import { initOrm } from '../helpers/infra';
import { migrateFresh, truncateAll, uuid } from '../helpers/db';
import { startHttpApp, type HttpTestApp } from '../helpers/http-app';
import { assertAllWalletsConsistent, brl, createWallet, submit, wagerBody, type TestWallet } from '../helpers/wager';
import { FakeFifoQueue } from '../helpers/fake-fifo-queue';
import { buildConsumer, drainConsumers, wagerMessage } from '../helpers/consumer';
import { CrashError, crashAt } from '../helpers/outbox';

let orm: MikroORM;
let http: HttpTestApp;
const exec = <T = Record<string, unknown>>(sql: string, params: unknown[] = []) =>
  orm.em.getConnection().execute(sql, params) as Promise<T[]>;
const count = async (sql: string, params: unknown[] = []) => Number((await exec<{ n: string }>(sql, params))[0]!.n);
const balance = async (w: TestWallet) => (await http.get(`/wallets/${w.walletId}`)).body.balance.amount as string;

/** UoW que falha com erro transitório nas primeiras `n` execuções. */
const flaky = (n: number) => (real: UnitOfWork): UnitOfWork => {
  let calls = 0;
  return { run: (work, opts) => (calls++ < n ? Promise.reject(new TransientError('database unavailable')) : real.run(work, opts)) };
};
/** UoW que demora `ms` antes de executar. */
const slow = (ms: number) => (real: UnitOfWork): UnitOfWork => ({ run: async (work, opts) => { await Bun.sleep(ms); return real.run(work, opts); } });

beforeAll(async () => {
  orm = await initOrm();
  await migrateFresh(orm);
  http = await startHttpApp();
});
afterAll(async () => {
  await http?.close();
  await orm?.close(true);
});
beforeEach(async () => {
  await truncateAll(orm);
});
afterEach(async () => {
  await assertAllWalletsConsistent(orm);
});

describe('caminho feliz', () => {
  test('BET pela fila: mesmo use case do HTTP, inbox gravada no mesmo commit, ack depois', async () => {
    const w = await createWallet(http, '100.00');
    const queue = new FakeFifoQueue();
    const msg = wagerMessage(w, { kind: 'BET', amount: '25.00' });
    queue.send(msg, w.walletId);
    const { consumer, metrics } = buildConsumer(orm, queue);

    expect(await consumer.pollOnce()).toBe(1);
    expect(queue.pending).toBe(0);
    expect(queue.acked).toHaveLength(1);
    expect(await balance(w)).toBe('75.00');
    const [inbox] = await exec<{ consumer_name: string; processed_at: string | null }>(`select consumer_name, processed_at from inbox_messages where message_id = ?`, [msg.messageId]);
    expect(inbox!.consumer_name).toBe('wager-transactions-consumer');
    expect(inbox!.processed_at).not.toBeNull();
    const [tx] = await exec<{ status: string; correlation_id: string }>(`select status, correlation_id from wager_transactions where idempotency_key = ?`, [msg.data.idempotencyKey]);
    expect(tx).toEqual({ status: 'PROCESSED', correlation_id: msg.messageId });
    // eventos carregam causationId = messageId
    const [evt] = await exec<{ payload: { causationId: string } }>(`select payload from outbox_messages where event_type = 'WagerTransactionProcessed'`);
    expect(evt!.payload.causationId).toBe(msg.messageId);
    expect(await metrics.value('consumer_messages_total')).toBe(1);
  });

  test('rejeição de negócio (saldo insuficiente) é terminal: ack, transação REJECTED auditável', async () => {
    const w = await createWallet(http, '10.00');
    const queue = new FakeFifoQueue();
    queue.send(wagerMessage(w, { kind: 'BET', amount: '50.00' }), w.walletId);
    await buildConsumer(orm, queue).consumer.pollOnce();
    expect(queue.pending).toBe(0);
    expect(queue.dlq).toHaveLength(0);
    expect(await count(`select count(*)::text as n from wager_transactions where status = 'REJECTED' and failure_code = 'INSUFFICIENT_FUNDS'`)).toBe(1);
  });

  test('ordem FIFO por grupo: ROLLBACK depois da BET no mesmo grupo → BET aplicada e revertida', async () => {
    const w = await createWallet(http, '100.00');
    const queue = new FakeFifoQueue();
    const bet = `bet-${uuid()}`;
    queue.send(wagerMessage(w, { kind: 'BET', amount: '30.00', externalTransactionId: bet }), w.walletId);
    queue.send(wagerMessage(w, { kind: 'ROLLBACK', amount: '30.00', referenceExternalTransactionId: bet }), w.walletId);
    await buildConsumer(orm, queue).consumer.pollOnce();
    expect(await balance(w)).toBe('100.00');
    expect(await count(`select count(*)::text as n from wager_transactions where kind = 'ROLLBACK' and status = 'PROCESSED'`)).toBe(1);
  });

  test('HTTP e fila compartilham a idempotência: mesma chave pelos dois canais → um efeito', async () => {
    const w = await createWallet(http, '100.00');
    const msg = wagerMessage(w, { kind: 'BET', amount: '10.00' });
    const viaHttp = await http.post('/wagering/transactions', (({ idempotencyKey, ...rest }) => rest)(msg.data), { 'idempotency-key': msg.data.idempotencyKey });
    expect(viaHttp.status).toBe(201);
    const queue = new FakeFifoQueue();
    queue.send(msg, w.walletId);
    await buildConsumer(orm, queue).consumer.pollOnce();
    expect(queue.acked).toHaveLength(1);
    expect(await balance(w)).toBe('90.00');
  });
});

describe('redelivery e inbox', () => {
  test('a mesma mensagem entregue de novo (mesmo messageId) → ack sem efeito, inbox detecta', async () => {
    const w = await createWallet(http, '100.00');
    const queue = new FakeFifoQueue();
    const msg = wagerMessage(w, { kind: 'BET', amount: '10.00' });
    queue.send(msg, w.walletId);
    queue.send(msg, w.walletId); // at-least-once: o broker entregou duas vezes
    const { consumer, metrics } = buildConsumer(orm, queue);
    await drainConsumers(queue, [consumer]);
    expect(queue.acked).toHaveLength(2);
    expect(await balance(w)).toBe('90.00');
    expect(await count(`select count(*)::text as n from inbox_messages`)).toBe(1);
    expect(await metrics.value('inbox_duplicates_total')).toBe(1);
  });

  test('mensagens diferentes com a mesma idempotencyKey → replay (2 linhas na inbox, 1 transação)', async () => {
    const w = await createWallet(http, '100.00');
    const queue = new FakeFifoQueue();
    const msg = wagerMessage(w, { kind: 'BET', amount: '10.00' });
    queue.send(msg, w.walletId);
    queue.send({ ...msg, messageId: `msg-${uuid()}` }, w.walletId);
    await drainConsumers(queue, [buildConsumer(orm, queue).consumer]);
    expect(await count(`select count(*)::text as n from inbox_messages`)).toBe(2);
    expect(await count(`select count(*)::text as n from wager_transactions where kind = 'BET'`)).toBe(1);
    expect(await balance(w)).toBe('90.00');
  });

  test('mesmo messageId com conteúdo diferente → DLQ (INBOX_PAYLOAD_MISMATCH), sem efeito', async () => {
    const w = await createWallet(http, '100.00');
    const queue = new FakeFifoQueue();
    const msg = wagerMessage(w, { kind: 'BET', amount: '10.00' });
    queue.send(msg, w.walletId);
    queue.send({ ...msg, data: { ...msg.data, money: brl('99.00') } }, w.walletId);
    await drainConsumers(queue, [buildConsumer(orm, queue).consumer]);
    expect(queue.dlq.map((d) => d.reason)).toEqual(['INBOX_PAYLOAD_MISMATCH']);
    expect(await balance(w)).toBe('90.00');
  });

  test('worker morre DEPOIS do commit e ANTES do ack → redelivery → inbox deduplica → um débito', async () => {
    const w = await createWallet(http, '100.00');
    const queue = new FakeFifoQueue();
    queue.send(wagerMessage(w, { kind: 'BET', amount: '40.00' }), w.walletId);

    const crashing = buildConsumer(orm, queue, { faults: crashAt('consumer:after-commit-before-ack') }).consumer;
    await expect(crashing.pollOnce()).rejects.toThrow(CrashError);
    expect(queue.acked).toHaveLength(0); // sem ack…
    expect(await balance(w)).toBe('60.00'); // …mas o commit aconteceu

    queue.expireVisibility(); // visibility timeout passa; o broker reentrega
    const survivor = buildConsumer(orm, queue);
    await survivor.consumer.pollOnce();
    expect(queue.acked).toHaveLength(1);
    expect(await balance(w)).toBe('60.00');
    expect(await count(`select count(*)::text as n from wallet_ledger_entries where direction = 'DEBIT'`)).toBe(1);
    expect(await survivor.metrics.value('inbox_duplicates_total')).toBe(1);
  });
});

describe('falhas: permanente → DLQ, transitória → retry', () => {
  test.each([
    ['JSON malformado', '{"messageId": ', 'MALFORMED_JSON'],
    ['tipo desconhecido', { messageId: 'x', type: 'SomethingElse', occurredAt: new Date().toISOString(), data: {} }, 'UNSUPPORTED_TYPE'],
    ['envelope sem data', { messageId: 'x', type: 'WagerTransactionRequested', occurredAt: new Date().toISOString() }, 'INVALID_ENVELOPE'],
  ])('%s → DLQ imediata', async (_l, body, reason) => {
    const queue = new FakeFifoQueue();
    queue.send(body, 'g');
    await buildConsumer(orm, queue).consumer.pollOnce();
    expect(queue.pending).toBe(0);
    expect(queue.dlq.map((d) => d.reason)).toEqual([reason]);
    expect(queue.dlq[0]!.message.receiveCount).toBe(1); // sem retries inúteis
  });

  test.each([
    ['amount numérico', (m: ReturnType<typeof wagerMessage>) => ({ ...m, data: { ...m.data, money: { amount: 10, currency: 'BRL' } } }), 'INVALID_ENVELOPE'],
    ['kind OPENING', (m: ReturnType<typeof wagerMessage>) => ({ ...m, data: { ...m.data, kind: 'OPENING' } }), 'INVALID_ENVELOPE'],
    ['3 casas decimais', (m: ReturnType<typeof wagerMessage>) => ({ ...m, data: { ...m.data, money: brl('1.001') } }), 'INVALID_MONEY'],
    ['REFUND sem referência', (m: ReturnType<typeof wagerMessage>) => ({ ...m, data: { ...m.data, kind: 'REFUND' } }), 'REFERENCE_REQUIRED'],
  ])('contrato inválido (%s) → DLQ, nada persistido', async (_l, mutate, reason) => {
    const w = await createWallet(http, '100.00');
    const queue = new FakeFifoQueue();
    queue.send(mutate(wagerMessage(w, { kind: 'BET', amount: '1.00' })), w.walletId);
    await buildConsumer(orm, queue).consumer.pollOnce();
    expect(queue.dlq.map((d) => d.reason)).toEqual([reason]);
    expect(await count(`select count(*)::text as n from inbox_messages`)).toBe(0);
    expect(await count(`select count(*)::text as n from wager_transactions where kind <> 'OPENING'`)).toBe(0);
  });

  test('conflito de idempotência (mesma chave, payload diferente) → DLQ com o código', async () => {
    const w = await createWallet(http, '100.00');
    const first = wagerBody(w, { kind: 'BET', amount: '10.00' });
    await http.post('/wagering/transactions', first.body, { 'idempotency-key': first.idempotencyKey });
    const queue = new FakeFifoQueue();
    queue.send({ messageId: `msg-${uuid()}`, type: 'WagerTransactionRequested', occurredAt: new Date().toISOString(), data: { ...first.body, money: brl('11.00'), idempotencyKey: first.idempotencyKey } }, w.walletId);
    await buildConsumer(orm, queue).consumer.pollOnce();
    expect(queue.dlq.map((d) => d.reason)).toEqual(['IDEMPOTENCY_KEY_PAYLOAD_MISMATCH']);
    expect(await balance(w)).toBe('90.00');
  });

  test('erro transitório: sem ack, volta para a fila com backoff e é processada quando o banco volta', async () => {
    const w = await createWallet(http, '100.00');
    const queue = new FakeFifoQueue();
    queue.send(wagerMessage(w, { kind: 'BET', amount: '10.00' }), w.walletId);
    const { consumer, metrics } = buildConsumer(orm, queue, { uow: flaky(2), config: { retryBaseSeconds: 0.05, retryMaxSeconds: 0.05 } });

    expect(await consumer.pollOnce()).toBe(1);
    expect(queue.pending).toBe(1);
    expect(queue.acked).toHaveLength(0);
    await Bun.sleep(80);
    await consumer.pollOnce(); // 2ª falha
    await Bun.sleep(80);
    await consumer.pollOnce(); // sucesso na 3ª entrega
    expect(queue.acked).toHaveLength(1);
    expect(await balance(w)).toBe('90.00');
    expect(await metrics.value('consumer_retries_total')).toBe(2);
  });

  test('erro transitório persistente → DLQ após maxReceives, nada persistido', async () => {
    const w = await createWallet(http, '100.00');
    const queue = new FakeFifoQueue(10);
    queue.send(wagerMessage(w, { kind: 'BET', amount: '10.00' }), w.walletId);
    const { consumer } = buildConsumer(orm, queue, { uow: flaky(Number.POSITIVE_INFINITY), config: { maxReceives: 3 } });
    await drainConsumers(queue, [consumer]);
    expect(queue.dlq).toHaveLength(1);
    expect(queue.dlq[0]).toMatchObject({ reason: 'MAX_RECEIVES_EXCEEDED' });
    expect(queue.dlq[0]!.message.receiveCount).toBe(3);
    expect(await balance(w)).toBe('100.00');
  });

  test('falha transitória num grupo preserva a ordem: a mensagem seguinte do grupo não é processada antes', async () => {
    const w = await createWallet(http, '100.00');
    const queue = new FakeFifoQueue();
    const bet = `bet-${uuid()}`;
    queue.send(wagerMessage(w, { kind: 'BET', amount: '30.00', externalTransactionId: bet }), w.walletId);
    queue.send(wagerMessage(w, { kind: 'REFUND', amount: '30.00', referenceExternalTransactionId: bet }), w.walletId);
    const { consumer } = buildConsumer(orm, queue, { uow: flaky(1) });
    await consumer.pollOnce();
    // BET falhou; o REFUND foi devolvido sem processar (não virou PENDING_REFERENCE)
    expect(await count(`select count(*)::text as n from wager_transactions where kind <> 'OPENING'`)).toBe(0);
    await drainConsumers(queue, [consumer]);
    expect(await count(`select count(*)::text as n from wager_transactions where kind = 'REFUND' and status = 'PROCESSED'`)).toBe(1);
    expect(await balance(w)).toBe('100.00');
  });
});

describe('shutdown e concorrência', () => {
  test('SIGTERM: conclui a mensagem em andamento, devolve as não iniciadas', async () => {
    const w = await createWallet(http, '100.00');
    const queue = new FakeFifoQueue();
    for (let i = 0; i < 4; i++) queue.send(wagerMessage(w, { kind: 'BET', amount: '1.00' }), w.walletId); // mesmo grupo → sequenciais
    const { consumer } = buildConsumer(orm, queue, { uow: slow(150) });
    consumer.start();
    await Bun.sleep(60); // 1ª mensagem em andamento
    await consumer.stop();
    expect(queue.acked).toHaveLength(1); // a que estava em andamento terminou e teve ack
    expect(queue.pending).toBe(3);
    expect(queue.inFlight).toBe(0); // as demais voltaram imediatamente (visibility 0)
    expect(await balance(w)).toBe('99.00');
  });

  test('3 consumidores na mesma fila, mensagens duplicadas e várias wallets → cada transação uma vez', async () => {
    const wallets = await Promise.all(Array.from({ length: 4 }, () => createWallet(http, '100.00')));
    const queue = new FakeFifoQueue();
    const messages = wallets.flatMap((w) => Array.from({ length: 10 }, (_, i) => ({ w, m: wagerMessage(w, { kind: i % 3 === 0 ? 'WIN' : 'BET', amount: '12.50' }) })));
    for (const { w, m } of messages) {
      queue.send(m, w.walletId);
      if (Math.random() < 0.5) queue.send(m, w.walletId); // redelivery
    }
    const consumers = [0, 1, 2].map(() => buildConsumer(orm, queue).consumer);
    await drainConsumers(queue, consumers);
    expect(queue.pending).toBe(0);
    expect(queue.dlq).toHaveLength(0);
    expect(await count(`select count(*)::text as n from wager_transactions where kind <> 'OPENING'`)).toBe(messages.length);
    expect(await count(`select count(*)::text as n from inbox_messages`)).toBe(messages.length);
  });

  test('consumidor e HTTP concorrentes na mesma wallet: saldo nunca negativo', async () => {
    const w = await createWallet(http, '100.00');
    const queue = new FakeFifoQueue();
    for (let i = 0; i < 10; i++) queue.send(wagerMessage(w, { kind: 'BET', amount: '10.00' }), `${w.walletId}-${i}`); // grupos distintos → paralelo
    const consumer = buildConsumer(orm, queue).consumer;
    const httpBets = Array.from({ length: 10 }, () => submit(http, w, { kind: 'BET', amount: '10.00' }));
    await Promise.all([drainConsumers(queue, [consumer]), ...httpBets]);
    expect(await balance(w)).toBe('0.00');
    expect(await count(`select count(*)::text as n from wager_transactions where status = 'PROCESSED' and kind = 'BET'`)).toBe(10);
  });
});
