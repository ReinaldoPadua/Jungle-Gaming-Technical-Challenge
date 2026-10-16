import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import type { MikroORM } from '@mikro-orm/postgresql';
import { initOrm } from '../helpers/infra';
import { applyMovement, migrateFresh, truncateAll, uuid, type WalletFixture } from '../helpers/db';
import { startHttpApp, type HttpTestApp } from '../helpers/http-app';

let orm: MikroORM;
let http: HttpTestApp;
const exec = (sql: string, params: unknown[] = []) => orm.em.getConnection().execute(sql, params);

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

const brl = (amount: string) => ({ amount, currency: 'BRL' });
const createWallet = (initial = '1000.00', playerId = uuid()) =>
  http.post('/wallets', { playerId, initialBalance: brl(initial) });

async function walletWithMovements(n: number): Promise<WalletFixture> {
  const res = await createWallet('1000.00');
  const w = { walletId: res.body.id, playerId: res.body.playerId };
  for (let i = 0; i < n; i++) {
    await orm.em.fork().transactional((em) =>
      applyMovement(em, w, i % 2 === 0 ? { kind: 'BET', amount: '10.00', direction: 'DEBIT' } : { kind: 'WIN', amount: '1.00', direction: 'CREDIT' }),
    );
  }
  return w;
}

// ================================================================ POST /wallets
describe('POST /wallets', () => {
  test('201: cria wallet com OPENING + CREDIT + evento na outbox, tudo no mesmo commit', async () => {
    const playerId = uuid();
    const res = await http.post('/wallets', { playerId, initialBalance: brl('1000.00') }, { 'x-correlation-id': 'corr-123' });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ playerId, balance: brl('1000.00'), version: 1 });
    expect(res.body.id).toMatch(/^[0-9a-f-]{36}$/);

    const [opening] = await exec(`select kind, status, amount, correlation_id from wager_transactions where wallet_id = ?`, [res.body.id]);
    expect(opening).toEqual({ kind: 'OPENING', status: 'PROCESSED', amount: '1000.00', correlation_id: 'corr-123' });
    const entries = await exec(`select direction, amount, balance_before, balance_after, sequence from wallet_ledger_entries where wallet_id = ?`, [res.body.id]);
    expect(entries).toEqual([{ direction: 'CREDIT', amount: '1000.00', balance_before: '0.00', balance_after: '1000.00', sequence: '1' }]);
    const events = await exec(`select event_type, payload from outbox_messages where aggregate_id = ?`, [res.body.id]);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ event_type: 'WalletBalanceChanged' });
    expect((events[0] as { payload: { correlationId: string } }).payload.correlationId).toBe('corr-123');
  });

  test('201: saldo inicial zero não gera OPENING, ledger nem evento', async () => {
    const res = await createWallet('0.00');
    expect(res.status).toBe(201);
    expect(res.body.balance).toEqual(brl('0.00'));
    expect(await exec(`select 1 from wager_transactions where wallet_id = ?`, [res.body.id])).toHaveLength(0);
    expect(await exec(`select 1 from wallet_ledger_entries where wallet_id = ?`, [res.body.id])).toHaveLength(0);
    expect(await exec(`select 1 from outbox_messages`)).toHaveLength(0);
  });

  test('normaliza a escala: "25" vira "25.00"', async () => {
    expect((await createWallet('25')).body.balance).toEqual(brl('25.00'));
  });

  test('409: wallet duplicada para (player, moeda); outra moeda é permitida', async () => {
    const playerId = uuid();
    expect((await createWallet('10.00', playerId)).status).toBe(201);
    const dup = await createWallet('10.00', playerId);
    expect(dup.status).toBe(409);
    expect(dup.body.error.code).toBe('WALLET_ALREADY_EXISTS');
    const usd = await http.post('/wallets', { playerId, initialBalance: { amount: '5.00', currency: 'USD' } });
    expect(usd.status).toBe(201);
    // nada de lixo da tentativa duplicada (rollback total)
    expect(await exec(`select 1 from wager_transactions where player_id = ? and currency = 'BRL'`, [playerId])).toHaveLength(1);
  });

  test('corrida: 20 criações simultâneas para o mesmo player → exatamente 1 wallet', async () => {
    const playerId = uuid();
    const results = await Promise.all(Array.from({ length: 20 }, () => createWallet('100.00', playerId)));
    const statuses = results.map((r) => r.status).sort();
    expect(statuses.filter((s) => s === 201)).toHaveLength(1);
    expect(statuses.filter((s) => s === 409)).toHaveLength(19);
    expect(await exec(`select 1 from wallets where player_id = ?`, [playerId])).toHaveLength(1);
    expect(await exec(`select 1 from wallet_ledger_entries`)).toHaveLength(1);
  });

  test.each([
    ['amount numérico', { playerId: uuid(), initialBalance: { amount: 10, currency: 'BRL' } }],
    ['notação científica', { playerId: uuid(), initialBalance: brl('1e3') }],
    ['negativo', { playerId: uuid(), initialBalance: brl('-1.00') }],
    ['3 casas decimais', { playerId: uuid(), initialBalance: brl('1.001') }],
    ['NaN', { playerId: uuid(), initialBalance: brl('NaN') }],
    ['vazio', { playerId: uuid(), initialBalance: brl('') }],
    ['moeda inválida', { playerId: uuid(), initialBalance: { amount: '1.00', currency: 'real' } }],
    ['playerId não-UUID', { playerId: 'abc', initialBalance: brl('1.00') }],
    ['sem initialBalance', { playerId: uuid() }],
    ['campo extra', { playerId: uuid(), initialBalance: brl('1.00'), balance: '5' }],
  ])('400: %s', async (_label, body) => {
    const res = await http.post('/wallets', body);
    expect(res.status).toBe(400);
    expect(typeof res.body.error.code).toBe('string');
    expect(typeof res.body.error.message).toBe('string');
  });

  test('400: JSON malformado', async () => {
    const res = await http.post('/wallets', '{"playerId": ');
    expect(res.status).toBe(400);
    expect(res.body.error).toBeDefined();
  });
});

// ============================================================= GET /wallets/:id
describe('GET /wallets/:walletId', () => {
  test('200 com saldo e version', async () => {
    const created = await createWallet('42.50');
    const res = await http.get(`/wallets/${created.body.id}`);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ id: created.body.id, balance: brl('42.50'), version: 1 });
  });

  test('404 para wallet inexistente; 400 para id não-UUID', async () => {
    const missing = await http.get(`/wallets/${uuid()}`);
    expect(missing.status).toBe(404);
    expect(missing.body.error.code).toBe('WALLET_NOT_FOUND');
    expect((await http.get('/wallets/not-a-uuid')).status).toBe(400);
  });
});

// ====================================================== GET /wallets/:id/ledger
describe('GET /wallets/:walletId/ledger', () => {
  test('pagina do mais recente ao mais antigo com cursor opaco, sem repetir nem pular', async () => {
    const w = await walletWithMovements(6); // opening + 6 = 7 lançamentos
    const seen: number[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const qs: string = cursor ? `?limit=3&cursor=${cursor}` : '?limit=3';
      const res = await http.get(`/wallets/${w.walletId}/ledger${qs}`);
      expect(res.status).toBe(200);
      seen.push(...res.body.items.map((i: { sequence: number }) => i.sequence));
      cursor = res.body.nextCursor;
      pages++;
    } while (cursor);
    expect(seen).toEqual([7, 6, 5, 4, 3, 2, 1]);
    expect(pages).toBe(3);
  });

  test('cursor é estável: lançamentos novos não deslocam a próxima página', async () => {
    const w = await walletWithMovements(4); // 5 lançamentos
    const first = await http.get(`/wallets/${w.walletId}/ledger?limit=2`);
    expect(first.body.items.map((i: { sequence: number }) => i.sequence)).toEqual([5, 4]);
    // chegam 3 lançamentos novos entre uma página e outra
    for (let i = 0; i < 3; i++) await orm.em.fork().transactional((em) => applyMovement(em, w, { kind: 'WIN', amount: '1.00', direction: 'CREDIT' }));
    const second = await http.get(`/wallets/${w.walletId}/ledger?limit=2&cursor=${first.body.nextCursor}`);
    expect(second.body.items.map((i: { sequence: number }) => i.sequence)).toEqual([3, 2]);
  });

  test('itens trazem valores como MoneyProps (string)', async () => {
    const w = await walletWithMovements(1);
    const res = await http.get(`/wallets/${w.walletId}/ledger?limit=1`);
    expect(res.body.items[0]).toMatchObject({
      direction: 'DEBIT', money: brl('10.00'), balanceBefore: brl('1000.00'), balanceAfter: brl('990.00'), sequence: 2,
    });
  });

  test('limit default 50, máximo 200; cursor inválido ou de outra wallet → 400', async () => {
    const a = await walletWithMovements(2);
    const b = await walletWithMovements(2);
    expect((await http.get(`/wallets/${a.walletId}/ledger`)).body.items).toHaveLength(3);
    expect((await http.get(`/wallets/${a.walletId}/ledger?limit=201`)).status).toBe(400);
    expect((await http.get(`/wallets/${a.walletId}/ledger?limit=0`)).status).toBe(400);
    const garbage = await http.get(`/wallets/${a.walletId}/ledger?cursor=zzz`);
    expect(garbage.status).toBe(400);
    expect(garbage.body.error.code).toBe('INVALID_CURSOR');
    const cursorOfB = (await http.get(`/wallets/${b.walletId}/ledger?limit=1`)).body.nextCursor;
    expect((await http.get(`/wallets/${a.walletId}/ledger?cursor=${cursorOfB}`)).body.error.code).toBe('INVALID_CURSOR');
  });

  test('404 para wallet inexistente', async () => {
    expect((await http.get(`/wallets/${uuid()}/ledger`)).status).toBe(404);
  });
});

// ============================================== POST /wallets/:id/reconciliation
describe('POST /wallets/:walletId/reconciliation', () => {
  test('wallet consistente', async () => {
    const w = await walletWithMovements(5); // 1000 −10 +1 −10 +1 −10 = 972
    const res = await http.post(`/wallets/${w.walletId}/reconciliation`);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      walletId: w.walletId,
      storedBalance: brl('972.00'),
      calculatedBalance: brl('972.00'),
      difference: brl('0.00'),
      consistent: true,
      checkedEntries: 6,
      chainBreaks: 0,
    });
  });

  test('wallet com saldo zero e sem lançamentos é consistente', async () => {
    const created = await createWallet('0.00');
    const res = await http.post(`/wallets/${created.body.id}/reconciliation`);
    expect(res.body).toMatchObject({ consistent: true, checkedEntries: 0, difference: brl('0.00') });
  });

  test('divergência (simulada contornando os triggers) é sinalizada, contabilizada e NÃO corrigida', async () => {
    const w = await walletWithMovements(2);
    // simula corrupção: único jeito é desligar os triggers de propósito
    await exec('alter table wallets disable trigger user');
    try {
      await exec(`update wallets set balance_amount = balance_amount + 5, version = version + 1 where id = ?`, [w.walletId]);
    } finally {
      await exec('alter table wallets enable trigger user');
    }
    const metricsBefore = await mismatchCount();
    const res = await http.post(`/wallets/${w.walletId}/reconciliation`);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      storedBalance: brl('996.00'),
      calculatedBalance: brl('991.00'),
      difference: brl('5.00'),
      consistent: false,
      lastEntryMatchesStored: false,
    });
    expect(await mismatchCount()).toBe(metricsBefore + 1);
    // não corrigiu
    const [row] = await exec(`select balance_amount from wallets where id = ?`, [w.walletId]);
    expect(row).toEqual({ balance_amount: '996.00' });
  });

  test('404 para wallet inexistente', async () => {
    expect((await http.post(`/wallets/${uuid()}/reconciliation`)).status).toBe(404);
  });
});

describe('formato de erro e /metrics', () => {
  test('rota inexistente → 404 com envelope padrão', async () => {
    const res = await http.get('/nope');
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('ROUTE_NOT_FOUND');
  });

  test('/metrics expõe contadores em formato Prometheus', async () => {
    await createWallet('1.00');
    const res = await http.get('/metrics');
    expect(res.status).toBe(200);
    expect(res.body).toContain('wallets_opened_total{currency="BRL"');
  });
});

async function mismatchCount(): Promise<number> {
  const text = (await http.get('/metrics')).body as string;
  const m = text.match(/^reconciliation_mismatches_total(?:\{[^}]*\})? (\d+)/m);
  return m ? Number(m[1]) : 0;
}
