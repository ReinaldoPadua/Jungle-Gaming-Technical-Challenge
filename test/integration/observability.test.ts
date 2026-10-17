/**
 * Seção 12: logs estruturados com correlação, sem payload financeiro; métricas
 * exigidas expostas; conflito de lock visível (métrica + log + 503).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import type { MikroORM } from '@mikro-orm/postgresql';
import { setLogSink } from '../../src/infrastructure/observability/json-logger';
import { initOrm } from '../helpers/infra';
import { migrateFresh, truncateAll } from '../helpers/db';
import { startHttpApp, type HttpTestApp } from '../helpers/http-app';
import { createWallet, submit, wagerBody } from '../helpers/wager';

let orm: MikroORM;
let http: HttpTestApp;
let lines: Record<string, any>[] = [];
let restoreSink: () => void;
const previousEnv = { LOG_LEVEL: process.env.LOG_LEVEL, DB_LOCK_TIMEOUT_MS: process.env.DB_LOCK_TIMEOUT_MS };

/** Soma das amostras de uma métrica cujos labels contêm todos os pares de `match`. */
async function metric(name: string, match: Record<string, string> = {}): Promise<number> {
  const text = (await http.get('/metrics')).body as string;
  let total = 0;
  for (const line of text.split('\n')) {
    const m = line.match(new RegExp(`^${name}(?:\\{([^}]*)\\})? (\\S+)$`));
    if (!m) continue;
    const labels = m[1] ?? '';
    if (Object.entries(match).every(([k, v]) => labels.includes(`${k}="${v}"`))) total += Number(m[2]);
  }
  return total;
}

beforeAll(async () => {
  orm = await initOrm();
  await migrateFresh(orm);
  // esta suíte precisa dos logs info e de um lock_timeout curto
  process.env.LOG_LEVEL = 'info';
  process.env.DB_LOCK_TIMEOUT_MS = '150';
  restoreSink = setLogSink((l) => lines.push(JSON.parse(l)));
  http = await startHttpApp();
});
afterAll(async () => {
  await http?.close();
  await orm?.close(true);
  restoreSink?.();
  Object.assign(process.env, previousEnv);
});
beforeEach(async () => {
  await truncateAll(orm);
  lines = [];
});

describe('logs estruturados', () => {
  test('X-Correlation-Id recebido é ecoado e propagado a todos os logs da requisição', async () => {
    const w = await createWallet(http, '100.00');
    lines = [];
    const { body, idempotencyKey } = wagerBody(w, { kind: 'BET', amount: '25.00' });
    const res = await http.post('/wagering/transactions', body, { 'idempotency-key': idempotencyKey, 'x-correlation-id': 'corr-abc' });
    expect(res.headers.get('x-correlation-id')).toBe('corr-abc');

    const handled = lines.find((l) => l.msg === 'wager transaction handled');
    expect(handled).toMatchObject({
      level: 'info', correlationId: 'corr-abc', transactionId: res.body.transactionId, walletId: w.walletId,
      providerId: 'provider-a', kind: 'BET', status: 'PROCESSED', outcome: 'processed',
    });
    const access = lines.find((l) => l.msg === 'http request');
    expect(access).toMatchObject({ correlationId: 'corr-abc', route: '/wagering/transactions', status: 201, method: 'POST' });
    expect(lines.filter((l) => l.correlationId && l.correlationId !== 'corr-abc')).toEqual([]);
  });

  test('sem header: correlationId é gerado e devolvido', async () => {
    const res = await http.get('/wallets/0192f291-27dd-7d3f-8071-5f8685deef37');
    const id = res.headers.get('x-correlation-id');
    expect(id).toMatch(/^[0-9a-f-]{36}$/);
    expect(lines.find((l) => l.msg === 'http request')!.correlationId).toBe(id);
  });

  test('nenhum valor monetário nem payload completo aparece nos logs', async () => {
    const w = await createWallet(http, '1234.56');
    await submit(http, w, { kind: 'BET', amount: '78.91' });
    await submit(http, w, { kind: 'BET', amount: '99999.99' }); // rejeitada
    await http.post(`/wallets/${w.walletId}/reconciliation`);
    const text = lines.map((l) => JSON.stringify(l)).join('\n');
    expect(lines.length).toBeGreaterThan(3);
    for (const value of ['1234.56', '78.91', '99999.99', '1155.65']) expect(text).not.toContain(value);
    expect(text).not.toContain('fortune-chimp'); // corpo da requisição não é logado
  });

  test('rota com id na métrica usa o padrão, não o valor (sem explosão de cardinalidade)', async () => {
    const w = await createWallet(http, '1.00');
    await http.get(`/wallets/${w.walletId}`);
    const metrics = (await http.get('/metrics')).body as string;
    expect(metrics).toContain('route="/wallets/:walletId"');
    expect(metrics).not.toContain(w.walletId);
  });
});

describe('métricas exigidas', () => {
  test('todas as séries da seção 12 estão expostas em /metrics', async () => {
    const w = await createWallet(http, '100.00');
    const before = {
      processed: await metric('wager_transactions_total', { kind: 'BET', status: 'PROCESSED', source: 'http' }),
      replays: await metric('idempotent_replays_total', { source: 'http' }),
      latency: await metric('wager_processing_duration_seconds_count', { outcome: 'processed' }),
    };
    const req = wagerBody(w, { kind: 'BET', amount: '10.00' });
    await http.post('/wagering/transactions', req.body, { 'idempotency-key': req.idempotencyKey });
    await http.post('/wagering/transactions', req.body, { 'idempotency-key': req.idempotencyKey });
    const text = (await http.get('/metrics')).body as string;
    const required = {
      'transações por status': 'wager_transactions_total',
      'duplicatas detectadas (idempotência)': 'idempotent_replays_total',
      'duplicatas detectadas (inbox)': 'inbox_duplicates_total',
      'retries (banco)': 'db_transaction_retries_total',
      'retries (fila)': 'consumer_retries_total',
      'retries (pendentes)': 'pending_reference_retries_total',
      'mensagens em DLQ': 'dlq_messages_total',
      'conflitos de lock': 'db_lock_conflicts_total',
      'outbox lag': 'outbox_lag_seconds',
      'latência de processamento': 'wager_processing_duration_seconds',
    };
    for (const name of Object.values(required)) expect(text).toContain(`# TYPE ${name} `);
    expect(await metric('wager_transactions_total', { kind: 'BET', status: 'PROCESSED', source: 'http' })).toBe(before.processed + 1);
    expect(await metric('idempotent_replays_total', { source: 'http' })).toBe(before.replays + 1);
    expect(await metric('wager_processing_duration_seconds_count', { outcome: 'processed' })).toBe(before.latency + 1);
  });

  test('conflito de lock: lock_timeout → retries → 503 + Retry-After, métrica e log', async () => {
    const w = await createWallet(http, '100.00');
    const conflictsBefore = await metric('db_lock_conflicts_total', { sqlstate: '55P03' });
    const retriesBefore = await metric('db_transaction_retries_total');
    lines = [];
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    // outra transação segura o lock da wallet por mais que lock_timeout × tentativas
    const holder = orm.em.fork().transactional(async (em) => {
      await em.execute('select 1 from wallets where id = ? for update', [w.walletId]);
      await held;
    });
    await Bun.sleep(50);
    const res = await submit(http, w, { kind: 'BET', amount: '10.00' });
    release();
    await holder;

    expect(res.status).toBe(503);
    expect(res.headers.get('retry-after')).toBe('1');
    expect(res.body.error.code).toBe('TEMPORARILY_UNAVAILABLE');
    expect(await metric('db_lock_conflicts_total', { sqlstate: '55P03' })).toBe(conflictsBefore + 3); // 3 tentativas
    expect(await metric('db_transaction_retries_total')).toBe(retriesBefore + 2); // 2 re-tentativas
    expect(lines.filter((l) => l.msg === 'transient database error, retrying transaction')).toHaveLength(2);
    expect(lines.find((l) => l.msg === 'database transaction failed after retries')).toMatchObject({ level: 'error', sqlstate: '55P03', walletId: w.walletId });

    // nada foi gravado; o cliente reenvia a MESMA requisição e dá certo
    const retry = await submit(http, w, { kind: 'BET', amount: '10.00' });
    expect(retry.status).toBe(201);
  });
});
