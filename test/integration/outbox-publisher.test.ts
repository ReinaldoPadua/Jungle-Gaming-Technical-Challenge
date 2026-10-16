/**
 * Transactional outbox contra PostgreSQL real. O broker é substituído por um
 * publisher em memória/arquivo AQUI para isolar a lógica de lease/retry; o
 * caminho com SQS real está em outbox-sqs.test.ts.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { MikroORM } from '@mikro-orm/postgresql';
import { DEFAULT_OUTBOX_PUBLISHER_CONFIG, OutboxPublisher, type OutboxPublisherConfig } from '../../src/modules/messaging/application/outbox-publisher';
import { OutboxMessage } from '../../src/modules/messaging/domain/outbox-message';
import { MikroOutboxStore } from '../../src/modules/messaging/infrastructure/persistence/mikro-outbox-store';
import { MikroOutboxRepository } from '../../src/modules/messaging/infrastructure/persistence/mikro-outbox.repository';
import { PromMetrics } from '../../src/infrastructure/observability/prom-metrics';
import { systemClock } from '../../src/shared/application/clock';
import { noFaults, type Faults } from '../../src/shared/application/faults';
import type { AppLogger } from '../../src/shared/application/logger';
import { initOrm } from '../helpers/infra';
import { migrateFresh, truncateAll } from '../helpers/db';
import { CrashError, crashAt, InMemoryPublisher, seedOutbox, TestEvent } from '../helpers/outbox';

let orm: MikroORM;
const quiet: AppLogger = { info: () => {}, warn: () => {}, error: () => {} };
const exec = <T = Record<string, unknown>>(sql: string, params: unknown[] = []) =>
  orm.em.getConnection().execute(sql, params) as Promise<T[]>;
const pending = async () => Number((await exec<{ n: string }>(`select count(*)::text as n from outbox_messages where published_at is null`))[0]!.n);

function makePublisher(
  publisher: InMemoryPublisher,
  opts: Partial<OutboxPublisherConfig> & { faults?: Faults; metrics?: PromMetrics } = {},
) {
  return new OutboxPublisher(new MikroOutboxStore(orm), publisher, systemClock, opts.metrics ?? new PromMetrics(), quiet, opts.faults ?? noFaults, {
    ...DEFAULT_OUTBOX_PUBLISHER_CONFIG,
    owner: opts.owner ?? 'test',
    batchSize: opts.batchSize ?? 50,
    leaseMs: opts.leaseMs ?? 30_000,
    pollIntervalMs: opts.pollIntervalMs ?? 20,
    statsIntervalMs: 0,
    retryPolicy: opts.retryPolicy ?? { baseDelayMs: 100, maxDelayMs: 1_000 },
  });
}

async function drain(...workers: OutboxPublisher[]): Promise<void> {
  for (let i = 0; i < 200 && (await pending()) > 0; i++) {
    await Promise.all(workers.map((w) => w.runOnce()));
  }
}

beforeAll(async () => {
  orm = await initOrm();
  await migrateFresh(orm);
});
afterAll(async () => {
  await orm?.close(true);
});
beforeEach(async () => {
  await truncateAll(orm);
});

describe('outbox publisher', () => {
  test('publica pendentes em ordem de ocorrência e marca published_at', async () => {
    const ids = await seedOutbox(orm, 5);
    const sink = new InMemoryPublisher();
    expect(await makePublisher(sink).runOnce()).toBe(5);
    expect(sink.published.map((p) => p.id)).toEqual(ids);
    expect(await pending()).toBe(0);
    // envelope publicado é o payload gravado
    expect(sink.published[0]!.payload).toMatchObject({ eventId: ids[0], eventType: 'TestEvent', version: 1 });
    // ciclo seguinte: nada a fazer
    expect(await makePublisher(sink).runOnce()).toBe(0);
  });

  test('nunca publica antes do COMMIT: mensagem de transação aberta é invisível ao publisher', async () => {
    const sink = new InMemoryPublisher();
    const worker = makePublisher(sink);
    await orm.em.fork().transactional(async (em) => {
      await new MikroOutboxRepository(em).enqueue(OutboxMessage.enqueue(TestEvent.make('agg', 1)));
      expect(await worker.runOnce()).toBe(0); // outra conexão: não vê o INSERT não confirmado
    });
    expect(await worker.runOnce()).toBe(1);
  });

  test('transação revertida nunca vira evento', async () => {
    const sink = new InMemoryPublisher();
    await expect(
      orm.em.fork().transactional(async (em) => {
        await new MikroOutboxRepository(em).enqueue(OutboxMessage.enqueue(TestEvent.make('agg', 1)));
        throw new Error('rollback');
      }),
    ).rejects.toThrow('rollback');
    expect(await makePublisher(sink).runOnce()).toBe(0);
    expect(sink.published).toHaveLength(0);
  });

  test('3 publishers concorrentes sobre a mesma outbox: cada evento publicado exatamente uma vez', async () => {
    const ids = await seedOutbox(orm, 300, { aggregates: 7 });
    const sinks = ['a', 'b', 'c'].map((n) => new InMemoryPublisher(n, () => undefined, 5));
    const workers = sinks.map((s, i) => makePublisher(s, { owner: `w${i}`, batchSize: 20 }));
    await drain(...workers);
    const all = sinks.flatMap((s) => s.published.map((p) => p.id));
    expect(all).toHaveLength(300);
    expect(new Set(all)).toEqual(new Set(ids));
    expect(await pending()).toBe(0);
  });

  test('leases são exclusivos: claims simultâneos recebem conjuntos disjuntos', async () => {
    await seedOutbox(orm, 30);
    const store = new MikroOutboxStore(orm);
    const now = new Date();
    const claims = await Promise.all(
      ['a', 'b', 'c', 'd', 'e'].map((owner) => store.claim({ owner, limit: 10, leaseMs: 30_000, now })),
    );
    const ids = claims.flatMap((c) => c.map((m) => m.message.id));
    expect(ids).toHaveLength(30); // 30 mensagens distribuídas, nenhuma repetida
    expect(new Set(ids).size).toBe(30);
    expect(await store.claim({ owner: 'f', limit: 10, leaseMs: 30_000, now })).toHaveLength(0);
  });

  test('crash DEPOIS de publicar e ANTES de marcar: outra instância republica após o lease; duplicata tem o mesmo eventId', async () => {
    const ids = await seedOutbox(orm, 4);
    const sinkA = new InMemoryPublisher('a');
    const a = makePublisher(sinkA, { owner: 'a', leaseMs: 300, faults: crashAt('outbox:after-publish') });
    await expect(a.runOnce()).rejects.toThrow(CrashError);
    expect(sinkA.published).toHaveLength(4); // chegou ao broker…
    expect(await pending()).toBe(4); // …mas não foi marcado

    const sinkB = new InMemoryPublisher('b');
    const b = makePublisher(sinkB, { owner: 'b', leaseMs: 300 });
    expect(await b.runOnce()).toBe(0); // lease de A ainda válido
    await Bun.sleep(350);
    expect(await b.runOnce()).toBe(4);
    expect(await pending()).toBe(0);

    // at-least-once: cada eventId apareceu 2×; consumidor que deduplica por eventId vê 4 eventos
    const deliveries = [...sinkA.published, ...sinkB.published].map((p) => p.id);
    expect(deliveries).toHaveLength(8);
    expect(new Set(deliveries)).toEqual(new Set(ids));
  });

  test('crash ANTES de publicar (lease tomado e processo morto): nada se perde', async () => {
    await seedOutbox(orm, 3);
    const store = new MikroOutboxStore(orm);
    const claimed = await store.claim({ owner: 'dead', limit: 10, leaseMs: 200, now: new Date() });
    expect(claimed).toHaveLength(3);
    const sink = new InMemoryPublisher('b');
    const b = makePublisher(sink, { owner: 'b' });
    expect(await b.runOnce()).toBe(0);
    await Bun.sleep(250);
    expect(await b.runOnce()).toBe(3);
    expect(sink.published).toHaveLength(3);
  });

  test('falha de publicação: backoff exponencial, last_error, nunca descarta; publica quando o broker volta', async () => {
    const [id] = await seedOutbox(orm, 1);
    let brokerUp = false;
    const sink = new InMemoryPublisher('p', () => (brokerUp ? undefined : 'ServiceUnavailable'));
    const metrics = new PromMetrics();
    const worker = makePublisher(sink, { metrics, retryPolicy: { baseDelayMs: 100, maxDelayMs: 1_000 } });

    expect(await worker.runOnce()).toBe(1);
    const [r1] = await exec<{ attempts: number; last_error: string; next_attempt_at: string; locked_by: string | null }>(
      `select attempts, last_error, next_attempt_at, locked_by from outbox_messages where id = ?`, [id],
    );
    expect(r1).toMatchObject({ attempts: 1, last_error: 'ServiceUnavailable', locked_by: null });
    expect(await worker.runOnce()).toBe(0); // ainda não venceu (backoff 100 ms)

    await Bun.sleep(120);
    expect(await worker.runOnce()).toBe(1);
    const [r2] = await exec<{ attempts: number; next_attempt_at: string }>(`select attempts, next_attempt_at from outbox_messages where id = ?`, [id]);
    expect(r2!.attempts).toBe(2);
    expect(new Date(r2!.next_attempt_at).getTime() - new Date(r1!.next_attempt_at).getTime()).toBeGreaterThanOrEqual(100); // 200 ms > 100 ms

    brokerUp = true;
    await Bun.sleep(220);
    expect(await worker.runOnce()).toBe(1);
    expect(await pending()).toBe(0);
    expect(await metrics.value('outbox_publish_failures_total')).toBe(2);
    expect(await metrics.value('outbox_published_total')).toBe(1);
  });

  test('broker lança exceção (fora do ar): todas as mensagens do ciclo são reagendadas', async () => {
    await seedOutbox(orm, 3);
    const worker = new OutboxPublisher(new MikroOutboxStore(orm), { publish: async () => { throw new Error('ECONNREFUSED'); } }, systemClock, new PromMetrics(), quiet, noFaults, {
      ...DEFAULT_OUTBOX_PUBLISHER_CONFIG, owner: 'x', statsIntervalMs: 0, retryPolicy: { baseDelayMs: 50, maxDelayMs: 50 },
    });
    expect(await worker.runOnce()).toBe(3);
    const rows = await exec<{ attempts: number; last_error: string }>(`select attempts, last_error from outbox_messages`);
    expect(rows.every((r) => r.attempts === 1 && r.last_error === 'ECONNREFUSED')).toBe(true);
  });

  test('métricas de lag e pendentes', async () => {
    await seedOutbox(orm, 2, { occurredAt: new Date(Date.now() - 5_000) });
    const metrics = new PromMetrics();
    const worker = makePublisher(new InMemoryPublisher(), { metrics });
    await worker.refreshStats(true);
    let text = await metrics.metrics();
    expect(text).toMatch(/^outbox_pending_messages 2$/m);
    const lag = Number(text.match(/^outbox_lag_seconds (\S+)$/m)![1]);
    expect(lag).toBeGreaterThanOrEqual(4.9);
    await worker.runOnce();
    await worker.refreshStats(true);
    text = await metrics.metrics();
    expect(text).toMatch(/^outbox_pending_messages 0$/m);
    expect(text).toMatch(/^outbox_lag_seconds 0$/m);
  });

  test('loop start/stop: publica o que chega e para limpo', async () => {
    const sink = new InMemoryPublisher();
    const worker = makePublisher(sink, { pollIntervalMs: 10 });
    worker.start();
    await seedOutbox(orm, 10);
    for (let i = 0; i < 100 && sink.published.length < 10; i++) await Bun.sleep(20);
    await worker.stop();
    expect(sink.published).toHaveLength(10);
  });
});

describe('crash real de processo', () => {
  const runWorker = (name: string, file: string, extra: Record<string, string> = {}) =>
    Bun.spawn(['bun', 'test/helpers/outbox-worker.ts'], {
      env: { ...process.env, WORKER_NAME: name, OUTBOX_TEST_PUBLISHER: `file:${file}`, OUTBOX_LEASE_MS: '500', ...extra },
      stdout: 'ignore',
      stderr: 'inherit',
    });

  test('commit → processo morre após publicar e antes de marcar → outra instância assume → todos publicados, duplicatas seguras', async () => {
    const ids = await seedOutbox(orm, 25);
    const file = join(mkdtempSync(join(tmpdir(), 'outbox-')), 'published.jsonl');

    const crashing = runWorker('a', file, { FAULTS: 'outbox:after-publish', OUTBOX_BATCH_SIZE: '10' });
    expect(await crashing.exited).toBe(137); // morreu de verdade (process.exit no ponto de falha)
    expect(await pending()).toBe(25);

    const survivor = runWorker('b', file);
    expect(await survivor.exited).toBe(0);
    expect(await pending()).toBe(0);

    const lines = existsSync(file) ? readFileSync(file, 'utf8').trim().split('\n').map((l) => JSON.parse(l) as { id: string; publisher: string }) : [];
    const fromA = lines.filter((l) => l.publisher === 'a');
    expect(fromA).toHaveLength(10); // primeiro lote chegou ao broker antes do crash
    expect(new Set(lines.map((l) => l.id))).toEqual(new Set(ids)); // nenhum perdido
    expect(lines.length).toBe(35); // 10 republicados (mesmo eventId) + 25
  });
});
