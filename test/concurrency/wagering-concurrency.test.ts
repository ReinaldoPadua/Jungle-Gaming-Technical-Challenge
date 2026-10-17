/**
 * Concorrência com paralelismo REAL (requisições HTTP simultâneas e processos
 * separados contra o mesmo PostgreSQL) — nada de mocks sequenciais.
 * Invariante final de todos: wallet.balance == saldo reconstruído pelo ledger.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import type { MikroORM } from '@mikro-orm/postgresql';
import { initOrm } from '../helpers/infra';
import { migrateFresh, truncateAll, uuid } from '../helpers/db';
import { startHttpApp, type HttpTestApp } from '../helpers/http-app';
import { spawnInstances, stopInstances, type Instance } from '../helpers/instances';
import { assertAllWalletsConsistent, brl, createWallet, submit, wagerBody } from '../helpers/wager';

let orm: MikroORM;
let http: HttpTestApp;
const exec = <T = Record<string, unknown>>(sql: string, params: unknown[] = []) =>
  orm.em.getConnection().execute(sql, params) as Promise<T[]>;
const count = async (sql: string, params: unknown[] = []) => Number((await exec<{ n: string }>(sql, params))[0]!.n);

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

describe('concorrência na mesma wallet', () => {
  test('a MESMA aposta enviada 50× em paralelo → exatamente um débito', async () => {
    const w = await createWallet(http, '1000.00');
    const req = wagerBody(w, { kind: 'BET', amount: '25.00' });
    const results = await Promise.all(
      Array.from({ length: 50 }, () => http.post('/wagering/transactions', req.body, { 'idempotency-key': req.idempotencyKey })),
    );
    const statuses = results.map((r) => r.status);
    expect(statuses.filter((s) => s === 201)).toHaveLength(1);
    expect(statuses.filter((s) => s === 200)).toHaveLength(49);
    expect(new Set(results.map((r) => r.body.transactionId)).size).toBe(1);
    expect(new Set(results.map((r) => r.body.balance.amount))).toEqual(new Set(['975.00']));
    expect(await count(`select count(*)::text as n from wallet_ledger_entries where wallet_id = ? and direction = 'DEBIT'`, [w.walletId])).toBe(1);
    expect(await count(`select count(*)::text as n from wager_transactions where wallet_id = ? and kind = 'BET'`, [w.walletId])).toBe(1);
    expect(await count(`select count(*)::text as n from outbox_messages where event_type = 'WalletBalanceChanged'`)).toBe(2); // opening + bet
  }, 60_000);

  test('cenário obrigatório (seção 8): 100.00 e duas BET de 80.00 simultâneas — repetido 20×', async () => {
    for (let round = 0; round < 20; round++) {
      const w = await createWallet(http, '100.00');
      const [a, b] = await Promise.all([
        submit(http, w, { kind: 'BET', amount: '80.00' }),
        submit(http, w, { kind: 'BET', amount: '80.00' }),
      ]);
      expect([a.status, b.status].sort()).toEqual([201, 422]);
      const rejected = a.status === 422 ? a : b;
      expect(rejected.body.failureCode).toBe('INSUFFICIENT_FUNDS');
      expect(rejected.body.balance).toEqual(brl('20.00')); // viu o saldo já debitado pela outra
      expect((await http.get(`/wallets/${w.walletId}`)).body.balance).toEqual(brl('20.00'));
      expect(await count(`select count(*)::text as n from wallet_ledger_entries where wallet_id = ? and direction = 'DEBIT'`, [w.walletId])).toBe(1);
      // retries de ambas não duplicam nada
      for (const r of [a, b]) {
        const tx = (await http.get(`/wagering/transactions/${r.body.transactionId}`)).body;
        const again = await submit(http, w, { kind: 'BET', amount: '80.00', externalTransactionId: tx.externalTransactionId });
        expect(again.body.idempotentReplay).toBe(true);
        expect(again.body.status).toBe(r.body.status);
      }
      expect((await http.get(`/wallets/${w.walletId}`)).body.balance).toEqual(brl('20.00'));
    }
  }, 60_000);

  test('hot wallet: 120 operações mistas simultâneas — saldo nunca negativo, exatidão total', async () => {
    const w = await createWallet(http, '500.00');
    const ops = Array.from({ length: 120 }, (_, i) =>
      i % 3 === 0 ? { kind: 'WIN' as const, amount: '7.35' } : { kind: 'BET' as const, amount: (10 + (i % 7)).toFixed(2) },
    );
    const results = await Promise.all(ops.map((op) => submit(http, w, op)));
    expect(results.every((r) => r.status === 201 || r.status === 422)).toBe(true);

    // saldo esperado = inicial + Σ (efeitos das aplicadas), calculado em centavos inteiros (BigInt)
    const cents = (s: string) => BigInt(s.replace('.', ''));
    let expected = cents('500.00');
    results.forEach((r, i) => {
      if (r.status !== 201) return;
      expected += ops[i]!.kind === 'WIN' ? cents(ops[i]!.amount) : -cents(ops[i]!.amount);
    });
    const balance = (await http.get(`/wallets/${w.walletId}`)).body.balance.amount as string;
    expect(cents(balance)).toBe(expected);
    expect(results.filter((r) => r.status === 422).every((r) => r.body.failureCode === 'INSUFFICIENT_FUNDS')).toBe(true);
    const applied = results.filter((r) => r.status === 201).length;
    expect(await count(`select count(*)::text as n from wallet_ledger_entries where wallet_id = ?`, [w.walletId])).toBe(applied + 1);
    expect((await http.post(`/wallets/${w.walletId}/reconciliation`)).body.consistent).toBe(true);
  }, 60_000);
});

describe('wallets distintas em paralelo', () => {
  test('20 wallets × 10 apostas simultâneas → todas aplicadas, sem interferência', async () => {
    const wallets = await Promise.all(Array.from({ length: 20 }, () => createWallet(http, '100.00')));
    const results = await Promise.all(
      wallets.flatMap((w) => Array.from({ length: 10 }, () => submit(http, w, { kind: 'BET', amount: '10.00' }))),
    );
    expect(results.every((r) => r.status === 201)).toBe(true);
    const balances = await exec<{ balance_amount: string }>(`select balance_amount from wallets`);
    expect(balances.every((b) => b.balance_amount === '0.00')).toBe(true);
  }, 60_000);
});

describe('múltiplas instâncias (3 processos independentes)', () => {
  let instances: Instance[];
  beforeAll(async () => {
    instances = await spawnInstances(3);
  });
  afterAll(async () => {
    await stopInstances(instances ?? []);
  });

  test('mesma aposta enviada às 3 instâncias (10× cada, em paralelo) → um único débito', async () => {
    const w = await createWallet(http, '100.00');
    const req = wagerBody(w, { kind: 'BET', amount: '30.00' });
    const results = await Promise.all(
      instances.flatMap((inst) =>
        Array.from({ length: 10 }, () => inst.post('/wagering/transactions', req.body, { 'idempotency-key': req.idempotencyKey })),
      ),
    );
    expect(results.filter((r) => r.status === 201)).toHaveLength(1);
    expect(results.filter((r) => r.status === 200)).toHaveLength(29);
    expect((await http.get(`/wallets/${w.walletId}`)).body.balance).toEqual(brl('70.00'));
  }, 60_000);

  test('3 instâncias disputando o saldo da mesma wallet: 30 BET de 10.00 sobre 100.00 → exatamente 10 aplicadas', async () => {
    const w = await createWallet(http, '100.00');
    const results = await Promise.all(
      Array.from({ length: 30 }, (_, i) => {
        const { body, idempotencyKey } = wagerBody(w, { kind: 'BET', amount: '10.00' });
        return instances[i % 3]!.post('/wagering/transactions', body, { 'idempotency-key': idempotencyKey });
      }),
    );
    expect(results.filter((r) => r.status === 201)).toHaveLength(10);
    expect(results.filter((r) => r.status === 422)).toHaveLength(20);
    expect((await http.get(`/wallets/${w.walletId}`)).body.balance).toEqual(brl('0.00'));
  }, 60_000);

  test('3 instâncias × várias wallets × replays cruzados → invariantes preservadas', async () => {
    const wallets = await Promise.all(Array.from({ length: 5 }, () => createWallet(http, '200.00')));
    const reqs = wallets.flatMap((w) => Array.from({ length: 12 }, (_, i) => wagerBody(w, { kind: i % 4 === 0 ? 'WIN' : 'BET', amount: '15.00' })));
    // cada requisição é enviada a TODAS as instâncias ao mesmo tempo (redelivery cruzada)
    const results = await Promise.all(
      reqs.flatMap((r) => instances.map((inst) => inst.post('/wagering/transactions', r.body, { 'idempotency-key': r.idempotencyKey }))),
    );
    expect(results.every((r) => [200, 201, 422].includes(r.status))).toBe(true);
    // cada transação foi decidida exatamente uma vez
    expect(await count(`select count(*)::text as n from wager_transactions where kind <> 'OPENING'`)).toBe(reqs.length);
    const firstDecisions = results.filter((r) => r.status === 201 || (r.status === 422 && !r.body.idempotentReplay));
    expect(firstDecisions).toHaveLength(reqs.length);
    for (const w of wallets) expect((await http.post(`/wallets/${w.walletId}/reconciliation`)).body.consistent).toBe(true);
  }, 60_000);
});
