/**
 * Cenário obrigatório 8: reinício do serviço com comprovação da consistência final.
 *
 * Duas instâncias recebem um fluxo contínuo de operações (inclusive referências
 * fora de ordem). No meio do fluxo, uma é morta com SIGKILL (sem shutdown) e a
 * outra é reiniciada com SIGTERM; substitutas sobem. O "provedor" reenvia a
 * MESMA requisição (mesma Idempotency-Key) sempre que a resposta não chega ou é
 * 503 — exatamente o contrato de at-least-once.
 *
 * Ao final: toda operação tem um desfecho definitivo, cada uma foi aplicada no
 * máximo uma vez, nenhum evento confirmado se perdeu, nenhuma pendente ficou
 * para trás e, para TODA wallet, saldo == ledger e a reconciliação é consistente.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { MikroORM } from '@mikro-orm/postgresql';
import { initOrm } from '../helpers/infra';
import { migrateFresh, truncateAll, uuid } from '../helpers/db';
import { startHttpApp, type HttpTestApp } from '../helpers/http-app';
import { spawnInstance, stopInstances, type Instance } from '../helpers/instances';
import { assertAllWalletsConsistent, createWallet, wagerBody, type TestWallet, type WagerInput } from '../helpers/wager';

let orm: MikroORM;
let http: HttpTestApp;
const exec = <T = Record<string, unknown>>(sql: string, params: unknown[] = []) =>
  orm.em.getConnection().execute(sql, params) as Promise<T[]>;
const count = async (sql: string, params: unknown[] = []) => Number((await exec<{ n: string }>(sql, params))[0]!.n);

const WORKER_ENV = { INSTANCE_MODULE: 'workers', PENDING_WORKER_ENABLED: 'true', PENDING_WORKER_POLL_INTERVAL_MS: '50' };

beforeAll(async () => {
  orm = await initOrm();
  await migrateFresh(orm);
  await truncateAll(orm);
  http = await startHttpApp();
});
afterAll(async () => {
  await http?.close();
  await orm?.close(true);
});

/** Plano determinístico de operações por wallet, incluindo reversões e referências fora de ordem. */
function planFor(w: TestWallet): WagerInput[] {
  const ops: WagerInput[] = [];
  for (let i = 0; i < 12; i++) {
    const bet = `bet-${uuid()}`;
    const amount = (10 + (i % 5) * 3).toFixed(2);
    switch (i % 4) {
      case 0: // ROLLBACK chega ANTES da BET
        ops.push({ kind: 'ROLLBACK', amount, referenceExternalTransactionId: bet });
        ops.push({ kind: 'BET', amount, externalTransactionId: bet });
        break;
      case 1: // BET seguida de REFUND
        ops.push({ kind: 'BET', amount, externalTransactionId: bet });
        ops.push({ kind: 'REFUND', amount, referenceExternalTransactionId: bet });
        break;
      case 2:
        ops.push({ kind: 'WIN', amount: '7.77' });
        ops.push({ kind: 'BET', amount });
        break;
      default:
        ops.push({ kind: 'LOSS', amount: '0.00' });
        ops.push({ kind: 'BET', amount: '1000.00' }); // sempre rejeitada por saldo
    }
  }
  return ops.map((op) => ({ ...op, externalTransactionId: op.externalTransactionId ?? `tx-${uuid()}` }));
}

describe('reinício do serviço (cenário 8)', () => {
  let instances: Instance[] = [];

  afterAll(async () => {
    await stopInstances(instances);
  });

  test('SIGKILL + SIGTERM no meio do tráfego → consistência final comprovada', async () => {
    instances = [await spawnInstance(WORKER_ENV), await spawnInstance(WORKER_ENV)];
    const wallets = await Promise.all(Array.from({ length: 4 }, () => createWallet(http, '500.00')));
    const requests = wallets.flatMap((w) => planFor(w).map((op) => ({ w, ...wagerBody(w, op) })));

    // cliente do provedor: reenvia a mesma requisição até obter um desfecho definitivo
    let rr = 0;
    let interrupted = 0; // requisições cuja conexão caiu e foram reenviadas
    const deliver = async (r: (typeof requests)[number]): Promise<number> => {
      for (let attempt = 0; attempt < 200; attempt++) {
        const alive = instances.filter((i) => i.proc.exitCode === null && !i.proc.killed);
        const target = alive[rr++ % Math.max(alive.length, 1)];
        if (!target) {
          await Bun.sleep(50);
          continue;
        }
        try {
          const res = await target.post('/wagering/transactions', r.body, { 'idempotency-key': r.idempotencyKey });
          if ([200, 201, 202, 422].includes(res.status)) return res.status;
          if (res.status !== 503) throw new Error(`unexpected ${res.status}: ${JSON.stringify(res.body)}`);
        } catch (err) {
          if (err instanceof Error && err.message.startsWith('unexpected')) throw err;
          // conexão recusada/resetada: a instância morreu no meio da requisição
          interrupted++;
        }
        await Bun.sleep(20);
      }
      throw new Error('no definitive answer');
    };

    // tráfego contínuo em lotes, com os reinícios no meio
    const statuses: number[] = [];
    const batches = 8;
    const size = Math.ceil(requests.length / batches);
    for (let b = 0; b < batches; b++) {
      const batch = requests.slice(b * size, (b + 1) * size);
      const inflight = batch.map(deliver);
      if (b === 2) {
        // crash: SIGKILL durante requisições em andamento — nenhum shutdown, nenhum finally
        await Bun.sleep(5);
        instances[0]!.proc.kill('SIGKILL');
        instances.push(await spawnInstance(WORKER_ENV));
      }
      if (b === 5) {
        // reinício gracioso: SIGTERM (conclui em andamento, fecha o pool) e substituta
        instances[1]!.proc.kill('SIGTERM');
        instances.push(await spawnInstance(WORKER_ENV));
      }
      statuses.push(...(await Promise.all(inflight)));
    }
    expect(await instances[0]!.proc.exited).toBe(137); // morreu mesmo por SIGKILL (128 + 9)
    // SIGTERM: o Nest conclui o shutdown (beforeApplicationShutdown → ORM) e re-emite o sinal → 143
    expect(await instances[1]!.proc.exited).toBe(143);

    // os workers das instâncias que sobraram resolvem as pendentes deixadas para trás
    for (let i = 0; i < 200 && (await count(`select count(*)::text as n from wager_transactions where status = 'PENDING_REFERENCE'`)) > 0; i++) {
      await Bun.sleep(50);
    }

    // ---------------------------------------------------------------- provas
    // 1. toda operação teve desfecho definitivo — inclusive as interrompidas pelo SIGKILL
    expect(statuses).toHaveLength(requests.length);
    expect(interrupted).toBeGreaterThan(0); // o crash aconteceu com requisições em voo
    console.log(`[restart] requests=${requests.length} interrupted-and-retried=${interrupted}`);

    // 2. cada operação aplicada no máximo uma vez (uma linha por idempotency key, nenhuma a mais)
    expect(await count(`select count(*)::text as n from wager_transactions where kind <> 'OPENING'`)).toBe(requests.length);
    expect(await count(`select count(distinct idempotency_key)::text as n from wager_transactions where kind <> 'OPENING'`)).toBe(requests.length);

    // 3. nenhuma pendente esquecida; nada em estado intermediário
    expect(await count(`select count(*)::text as n from wager_transactions where status in ('PENDING', 'PENDING_REFERENCE')`)).toBe(0);

    // 4. desfechos esperados do plano
    const byKind = await exec<{ kind: string; status: string; failure_code: string | null; n: string }>(
      `select kind, status, failure_code, count(*)::text as n from wager_transactions where kind <> 'OPENING'
        group by kind, status, failure_code order by kind, status`,
    );
    const n = (kind: string, status: string) => Number(byKind.find((r) => r.kind === kind && r.status === status)?.n ?? 0);
    expect(n('ROLLBACK', 'PROCESSED')).toBe(4 * 3); // todos os ROLLBACK que chegaram antes da BET
    expect(n('REFUND', 'PROCESSED')).toBe(4 * 3);
    expect(n('BET', 'REJECTED')).toBe(4 * 3); // as de 1000.00
    expect(n('LOSS', 'PROCESSED')).toBe(4 * 3);

    // 5. nenhum evento confirmado perdido: um evento por decisão, um BalanceChanged por lançamento
    expect(await count(`select count(*)::text as n from outbox_messages where event_type = 'WagerTransactionProcessed'`)).toBe(
      await count(`select count(*)::text as n from wager_transactions where status = 'PROCESSED' and kind <> 'OPENING'`),
    );
    expect(await count(`select count(*)::text as n from outbox_messages where event_type = 'WagerTransactionRejected'`)).toBe(
      await count(`select count(*)::text as n from wager_transactions where status = 'REJECTED'`),
    );
    expect(await count(`select count(*)::text as n from outbox_messages where event_type = 'WalletBalanceChanged'`)).toBe(
      await count(`select count(*)::text as n from wallet_ledger_entries`),
    );
    // ROLLBACK e BET do mesmo par podem chegar em qualquer ordem (mesmo lote, em paralelo, e
    // reenvios após o crash): exatamente um evento de pendência por transação que de fato esperou
    expect(await count(`select count(*)::text as n from outbox_messages where event_type = 'WagerTransactionPendingReference'`)).toBe(
      await count(`select count(*)::text as n from wager_transactions where attempts > 0`),
    );

    // 6. saldo esperado: em cada wallet, os índices 2, 6 e 10 fazem WIN 7.77 − BET
    // (ROLLBACK/BET e BET/REFUND se anulam; LOSS e a BET de 1000.00 não movem saldo)
    const expected = (500 * 100 + [2, 6, 10].reduce((acc, i) => acc + 777 - (10 + (i % 5) * 3) * 100, 0)) / 100;
    for (const w of wallets) {
      expect((await http.get(`/wallets/${w.walletId}`)).body.balance.amount).toBe(expected.toFixed(2));
      const rec = (await http.post(`/wallets/${w.walletId}/reconciliation`)).body;
      expect(rec).toMatchObject({ consistent: true, chainBreaks: 0, lastEntryMatchesStored: true });
    }

    // 7. invariante final: wallet.balance == saldo reconstruído pelo ledger, nenhum saldo negativo
    await assertAllWalletsConsistent(orm);
  }, 120_000);

  test('estado persistido antes de um crash é retomado por uma instância nova', async () => {
    await stopInstances(instances); // nenhum worker do teste anterior pode interferir
    instances = [];
    await truncateAll(orm);
    // instância SEM worker deixa pendências e morre com SIGKILL
    const noWorker = await spawnInstance({ INSTANCE_MODULE: 'workers', PENDING_WORKER_ENABLED: 'false' });
    const w = await createWallet(http, '100.00');
    const bets = Array.from({ length: 5 }, () => `bet-${uuid()}`);
    for (const bet of bets) {
      const rb = wagerBody(w, { kind: 'ROLLBACK', amount: '10.00', referenceExternalTransactionId: bet });
      expect((await noWorker.post('/wagering/transactions', rb.body, { 'idempotency-key': rb.idempotencyKey })).status).toBe(202);
      const b = wagerBody(w, { kind: 'BET', amount: '10.00', externalTransactionId: bet });
      expect((await noWorker.post('/wagering/transactions', b.body, { 'idempotency-key': b.idempotencyKey })).status).toBe(201);
    }
    noWorker.proc.kill('SIGKILL');
    await noWorker.proc.exited;
    expect(await count(`select count(*)::text as n from wager_transactions where status = 'PENDING_REFERENCE'`)).toBe(5);
    expect((await http.get(`/wallets/${w.walletId}`)).body.balance.amount).toBe('50.00');

    // nova instância (com worker) sobe e conclui o trabalho
    const fresh = await spawnInstance(WORKER_ENV);
    instances.push(fresh);
    for (let i = 0; i < 100 && (await count(`select count(*)::text as n from wager_transactions where status = 'PENDING_REFERENCE'`)) > 0; i++) {
      await Bun.sleep(50);
    }
    expect(await count(`select count(*)::text as n from wager_transactions where kind = 'ROLLBACK' and status = 'PROCESSED'`)).toBe(5);
    expect((await http.get(`/wallets/${w.walletId}`)).body.balance.amount).toBe('100.00');
    expect((await http.post(`/wallets/${w.walletId}/reconciliation`)).body.consistent).toBe(true);
    await assertAllWalletsConsistent(orm);
  }, 60_000);
});
