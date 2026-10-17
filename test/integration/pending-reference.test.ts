/**
 * Referências fora de ordem (seção 7.1) e o worker de PENDING_REFERENCE,
 * contra PostgreSQL real.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import type { MikroORM } from '@mikro-orm/postgresql';
import { MikroUnitOfWork } from '../../src/infrastructure/database/mikro-unit-of-work';
import { PromMetrics } from '../../src/infrastructure/observability/prom-metrics';
import { PendingReferenceWorker } from '../../src/modules/wagering/application/pending-reference.worker';
import { ProcessWagerTransactionUseCase } from '../../src/modules/wagering/application/process-wager-transaction.use-case';
import type { ReferenceRetryPolicy } from '../../src/modules/wagering/domain/reference-retry-policy';
import { DEFAULT_REFERENCE_RETRY_POLICY } from '../../src/modules/wagering/domain/reference-retry-policy';
import type { WagerTransactionKind } from '../../src/modules/wagering/domain/wager-transaction-kind';
import { systemClock } from '../../src/shared/application/clock';
import { uuidV7Generator } from '../../src/shared/application/id-generator';
import { initOrm } from '../helpers/infra';
import { migrateFresh, truncateAll, uuid } from '../helpers/db';
import { startHttpApp, type HttpTestApp } from '../helpers/http-app';
import { assertAllWalletsConsistent, createWallet, submit, wagerBody, type TestWallet, type WagerInput } from '../helpers/wager';
import { FakeFifoQueue } from '../helpers/fake-fifo-queue';
import { buildConsumer, drainConsumers, quietLogger, wagerMessage } from '../helpers/consumer';

let orm: MikroORM;
let http: HttpTestApp;
const exec = <T = Record<string, unknown>>(sql: string, params: unknown[] = []) =>
  orm.em.getConnection().execute(sql, params) as Promise<T[]>;
const count = async (sql: string, params: unknown[] = []) => Number((await exec<{ n: string }>(sql, params))[0]!.n);
const balance = async (w: TestWallet) => (await http.get(`/wallets/${w.walletId}`)).body.balance.amount as string;
const txState = async (id: string) =>
  (await exec<{ status: string; failure_code: string | null; attempts: number; next_attempt_at: string | null; reference_transaction_id: string | null }>(
    `select status, failure_code, attempts, next_attempt_at, reference_transaction_id from wager_transactions where id = ?`,
    [id],
  ))[0]!;
const events = async () => (await exec<{ event_type: string }>(`select event_type from outbox_messages order by occurred_at, event_type`)).map((e) => e.event_type);

const FAST: ReferenceRetryPolicy = { maxAttempts: 3, baseDelayMs: 20, maxDelayMs: 80, ttlMs: 60_000 };

function setup(policy: ReferenceRetryPolicy = FAST) {
  const metrics = new PromMetrics();
  const uow = new MikroUnitOfWork(orm, metrics);
  const useCase = new ProcessWagerTransactionUseCase(uow, systemClock, uuidV7Generator, metrics, policy);
  const worker = (concurrency = 4) =>
    new PendingReferenceWorker(uow, systemClock, uuidV7Generator, metrics, quietLogger, policy, { batchSize: 50, concurrency, pollIntervalMs: 10 });
  const send = (w: TestWallet, input: WagerInput) => {
    const { body, idempotencyKey } = wagerBody(w, input);
    return useCase.execute({ ...body, kind: body.kind as WagerTransactionKind, idempotencyKey, correlationId: 'test', source: 'http' });
  };
  return { metrics, useCase, worker, send };
}

/** Roda ciclos do worker até não haver pendentes vencidas (ou o limite). */
async function settleAll(workers: PendingReferenceWorker[], maxCycles = 100) {
  for (let i = 0; i < maxCycles; i++) {
    await Promise.all(workers.map((w) => w.runOnce()));
    if ((await count(`select count(*)::text as n from wager_transactions where status = 'PENDING_REFERENCE'`)) === 0) return;
    await Bun.sleep(15);
  }
}

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

describe('referência entregue depois (cenário obrigatório 7)', () => {
  test('ROLLBACK antes da BET (HTTP) → 202; BET chega → worker aplica o ROLLBACK', async () => {
    const w = await createWallet(http, '100.00');
    const { worker } = setup(DEFAULT_REFERENCE_RETRY_POLICY);
    const bet = `bet-${uuid()}`;
    const rb = await submit(http, w, { kind: 'ROLLBACK', amount: '30.00', referenceExternalTransactionId: bet });
    expect(rb.status).toBe(202);
    expect(await worker().runOnce()).toBe(0); // ainda não venceu (backoff de 500 ms)

    expect((await submit(http, w, { kind: 'BET', amount: '30.00', externalTransactionId: bet })).status).toBe(201);
    expect(await balance(w)).toBe('70.00');
    // a chegada da BET antecipou a próxima tentativa: o worker já pode processar
    expect(await worker().runOnce()).toBe(1);
    expect(await balance(w)).toBe('100.00');

    const state = await txState(rb.body.transactionId);
    expect(state.status).toBe('PROCESSED');
    expect(state.reference_transaction_id).not.toBeNull();
    expect(state.next_attempt_at).toBeNull();
    // replay agora reflete o estado terminal
    const replay = await submit(http, w, {
      kind: 'ROLLBACK', amount: '30.00', referenceExternalTransactionId: bet,
      externalTransactionId: (await http.get(`/wagering/transactions/${rb.body.transactionId}`)).body.externalTransactionId,
    });
    expect(replay.status).toBe(200);
    expect(replay.body).toMatchObject({ status: 'PROCESSED', balance: { amount: '100.00', currency: 'BRL' }, idempotentReplay: true });
    // eventos: Pending (1×, não repetido nos reagendamentos) → Processed + BalanceChanged
    const types = (await events()).filter((e) => e !== 'WalletBalanceChanged');
    expect(types.filter((e) => e === 'WagerTransactionPendingReference')).toHaveLength(1);
    expect(types.filter((e) => e === 'WagerTransactionProcessed')).toHaveLength(2); // BET + ROLLBACK
  });

  test('REFUND antes da BET pela FILA → pendente; BET pela fila → worker aplica', async () => {
    const w = await createWallet(http, '100.00');
    const { worker } = setup();
    const queue = new FakeFifoQueue();
    const bet = `bet-${uuid()}`;
    queue.send(wagerMessage(w, { kind: 'REFUND', amount: '25.00', referenceExternalTransactionId: bet }), `${w.walletId}-a`);
    const consumer = buildConsumer(orm, queue).consumer;
    await drainConsumers(queue, [consumer]);
    expect(await count(`select count(*)::text as n from wager_transactions where kind = 'REFUND' and status = 'PENDING_REFERENCE'`)).toBe(1);
    expect(queue.acked).toHaveLength(1); // pendente também é ack: o estado está persistido

    queue.send(wagerMessage(w, { kind: 'BET', amount: '25.00', externalTransactionId: bet }), `${w.walletId}-b`);
    await drainConsumers(queue, [consumer]);
    expect(await balance(w)).toBe('75.00');
    await settleAll([worker()]);
    expect(await balance(w)).toBe('100.00');
    expect(await count(`select count(*)::text as n from wager_transactions where kind = 'REFUND' and status = 'PROCESSED'`)).toBe(1);
  });

  test('cadeia: ROLLBACK(REFUND(BET)) chegando ao contrário → resolvida em ordem pelo worker', async () => {
    const w = await createWallet(http, '100.00');
    const { worker, send } = setup();
    const bet = `bet-${uuid()}`;
    const refund = `refund-${uuid()}`;
    await send(w, { kind: 'ROLLBACK', amount: '30.00', referenceExternalTransactionId: refund });
    await send(w, { kind: 'REFUND', amount: '30.00', referenceExternalTransactionId: bet, externalTransactionId: refund });
    await send(w, { kind: 'BET', amount: '30.00', externalTransactionId: bet });
    await settleAll([worker()]);
    // BET −30, REFUND +30, ROLLBACK do REFUND −30 → 70
    expect(await balance(w)).toBe('70.00');
    expect(await count(`select count(*)::text as n from wager_transactions where status = 'PROCESSED' and kind <> 'OPENING'`)).toBe(3);
  });
});

describe('limites da espera', () => {
  test('referência nunca chega → REJECTED REFERENCE_NOT_FOUND após maxAttempts + evento Rejected', async () => {
    const w = await createWallet(http, '100.00');
    const { worker, send, metrics } = setup();
    const res = await send(w, { kind: 'ROLLBACK', amount: '10.00', referenceExternalTransactionId: `ghost-${uuid()}` });
    expect(String(res.status)).toBe('PENDING_REFERENCE');
    await settleAll([worker()]);
    const state = await txState(res.transactionId);
    expect(state).toMatchObject({ status: 'REJECTED', failure_code: 'REFERENCE_NOT_FOUND', attempts: FAST.maxAttempts, next_attempt_at: null });
    expect(await events()).toContain('WagerTransactionRejected');
    expect(await balance(w)).toBe('100.00');
    expect(await metrics.value('pending_reference_retries_total')).toBe(FAST.maxAttempts); // 2 reagendamentos + 1 rejeição
  });

  test('TTL esgotado também rejeita, mesmo com tentativas sobrando', async () => {
    const w = await createWallet(http, '100.00');
    const { worker, send } = setup({ maxAttempts: 100, baseDelayMs: 10, maxDelayMs: 10, ttlMs: 60 });
    const res = await send(w, { kind: 'REFUND', amount: '10.00', referenceExternalTransactionId: `ghost-${uuid()}` });
    await Bun.sleep(80);
    await settleAll([worker()]);
    expect(await txState(res.transactionId)).toMatchObject({ status: 'REJECTED', failure_code: 'REFERENCE_NOT_FOUND' });
  }, 60_000);

  test('reagendamento aplica backoff exponencial (attempts e next_attempt_at crescem)', async () => {
    const w = await createWallet(http, '100.00');
    const { worker, send } = setup({ maxAttempts: 10, baseDelayMs: 30, maxDelayMs: 10_000, ttlMs: 60_000 });
    const res = await send(w, { kind: 'REFUND', amount: '10.00', referenceExternalTransactionId: `ghost-${uuid()}` });
    const s1 = await txState(res.transactionId);
    await Bun.sleep(40);
    expect(await worker().runOnce()).toBe(1);
    const s2 = await txState(res.transactionId);
    expect(s2.attempts).toBe(s1.attempts + 1);
    const gap1 = new Date(s2.next_attempt_at!).getTime() - Date.now();
    expect(gap1).toBeGreaterThan(30); // 2ª espera = 60 ms
    expect(await worker().runOnce()).toBe(0); // ainda não venceu
  });

  test('referência chega mas é inválida → rejeição com o código específico', async () => {
    const w = await createWallet(http, '100.00');
    const { worker, send } = setup();
    const bet = `bet-${uuid()}`;
    const res = await send(w, { kind: 'REFUND', amount: '10.00', referenceExternalTransactionId: bet });
    await send(w, { kind: 'BET', amount: '15.00', externalTransactionId: bet });
    await settleAll([worker()]);
    expect(await txState(res.transactionId)).toMatchObject({ status: 'REJECTED', failure_code: 'REFERENCE_AMOUNT_MISMATCH' });
    expect(await balance(w)).toBe('85.00');
  });

  test('ROLLBACK de WIN já gasto, resolvido pelo worker → REVERSAL_WOULD_OVERDRAW', async () => {
    const w = await createWallet(http, '0.00');
    const { worker, send } = setup();
    const win = `win-${uuid()}`;
    const rb = await send(w, { kind: 'ROLLBACK', amount: '50.00', referenceExternalTransactionId: win });
    await send(w, { kind: 'WIN', amount: '50.00', externalTransactionId: win });
    await send(w, { kind: 'BET', amount: '45.00' });
    await settleAll([worker()]);
    expect(await txState(rb.transactionId)).toMatchObject({ status: 'REJECTED', failure_code: 'REVERSAL_WOULD_OVERDRAW' });
    expect(await balance(w)).toBe('5.00');
  });
});

describe('concorrência do worker', () => {
  test('3 workers concorrentes sobre 30 pendentes em 5 wallets → cada uma aplicada exatamente uma vez', async () => {
    const wallets = await Promise.all(Array.from({ length: 5 }, () => createWallet(http, '1000.00')));
    const { worker, send } = setup();
    const bets: { w: TestWallet; ext: string }[] = [];
    for (const w of wallets) {
      for (let i = 0; i < 6; i++) {
        const ext = `bet-${uuid()}`;
        await send(w, { kind: 'ROLLBACK', amount: '10.00', referenceExternalTransactionId: ext });
        bets.push({ w, ext });
      }
    }
    await Promise.all(bets.map(({ w, ext }) => send(w, { kind: 'BET', amount: '10.00', externalTransactionId: ext })));
    await settleAll([worker(2), worker(2), worker(2)]);
    expect(await count(`select count(*)::text as n from wager_transactions where kind = 'ROLLBACK' and status = 'PROCESSED'`)).toBe(30);
    expect(await count(`select count(*)::text as n from wallet_ledger_entries where direction = 'CREDIT'`)).toBe(30 + 5); // rollbacks + aberturas
    expect(await count(`select count(*)::text as n from outbox_messages where event_type = 'WagerTransactionProcessed'`)).toBe(60);
    for (const w of wallets) expect(await balance(w)).toBe('1000.00');
  }, 60_000);

  test('worker e HTTP concorrentes na mesma wallet: sem deadlock, invariantes preservadas', async () => {
    const w = await createWallet(http, '500.00');
    const { worker, send } = setup();
    const exts = Array.from({ length: 15 }, () => `bet-${uuid()}`);
    for (const ext of exts) await send(w, { kind: 'REFUND', amount: '5.00', referenceExternalTransactionId: ext });
    const running = worker();
    running.start();
    await Promise.all([
      ...exts.map((ext) => submit(http, w, { kind: 'BET', amount: '5.00', externalTransactionId: ext })),
      ...Array.from({ length: 15 }, () => submit(http, w, { kind: 'BET', amount: '7.00' })),
    ]);
    for (let i = 0; i < 100 && (await count(`select count(*)::text as n from wager_transactions where status = 'PENDING_REFERENCE'`)) > 0; i++) await Bun.sleep(20);
    await running.stop();
    expect(await count(`select count(*)::text as n from wager_transactions where kind = 'REFUND' and status = 'PROCESSED'`)).toBe(15);
    expect(await balance(w)).toBe('395.00'); // 500 − 15×5 + 15×5 − 15×7
  }, 60_000);
});
