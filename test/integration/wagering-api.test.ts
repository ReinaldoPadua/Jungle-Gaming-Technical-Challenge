import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import type { MikroORM } from '@mikro-orm/postgresql';
import { initOrm } from '../helpers/infra';
import { migrateFresh, truncateAll, uuid } from '../helpers/db';
import { startHttpApp, type HttpTestApp } from '../helpers/http-app';
import { assertAllWalletsConsistent, brl, createWallet, submit, wagerBody, type TestWallet } from '../helpers/wager';

let orm: MikroORM;
let http: HttpTestApp;
const exec = <T = Record<string, unknown>>(sql: string, params: unknown[] = []) =>
  orm.em.getConnection().execute(sql, params) as Promise<T[]>;
const eventTypes = async () =>
  (await exec<{ event_type: string }>(`select event_type from outbox_messages where event_type <> 'WalletBalanceChanged' or payload->'data'->>'transactionId' in (select id::text from wager_transactions where kind <> 'OPENING') order by occurred_at, event_type`)).map((r) => r.event_type);
const ledgerCount = async (walletId: string) =>
  Number((await exec<{ n: string }>(`select count(*)::text as n from wallet_ledger_entries where wallet_id = ?`, [walletId]))[0]!.n);

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

describe('BET', () => {
  let w: TestWallet;
  beforeEach(async () => {
    w = await createWallet(http, '1000.00');
  });

  test('201 PROCESSED: debita, 1 lançamento DEBIT, eventos Processed + BalanceChanged na outbox', async () => {
    const res = await submit(http, w, { kind: 'BET', amount: '25.00' });
    expect(res.status).toBe(201);
    expect(res.body).toEqual({ transactionId: expect.any(String), status: 'PROCESSED', balance: brl('975.00'), idempotentReplay: false });
    expect(await ledgerCount(w.walletId)).toBe(2);
    expect(await eventTypes()).toEqual(['WagerTransactionProcessed', 'WalletBalanceChanged']);
    expect((await http.get(`/wallets/${w.walletId}`)).body).toMatchObject({ balance: brl('975.00'), version: 2 });
  });

  test('replay idêntico → 200, idempotentReplay=true, mesmo resultado, nenhum efeito novo', async () => {
    const req = wagerBody(w, { kind: 'BET', amount: '25.00' });
    const first = await http.post('/wagering/transactions', req.body, { 'idempotency-key': req.idempotencyKey });
    const again = await http.post('/wagering/transactions', req.body, { 'idempotency-key': req.idempotencyKey });
    expect(again.status).toBe(200);
    expect(again.body).toEqual({ ...first.body, idempotentReplay: true });
    expect(await ledgerCount(w.walletId)).toBe(2);
    expect((await eventTypes()).length).toBe(2);
  });

  test('replay devolve o saldo observado NAQUELE momento, mesmo após outras operações', async () => {
    const req = wagerBody(w, { kind: 'BET', amount: '25.00' });
    await http.post('/wagering/transactions', req.body, { 'idempotency-key': req.idempotencyKey });
    await submit(http, w, { kind: 'BET', amount: '100.00' });
    const again = await http.post('/wagering/transactions', req.body, { 'idempotency-key': req.idempotencyKey });
    expect(again.body.balance).toEqual(brl('975.00'));
    expect((await http.get(`/wallets/${w.walletId}`)).body.balance).toEqual(brl('875.00'));
  });

  test('escala do amount é normalizada no hash: "25" e "25.00" são o mesmo payload', async () => {
    const ext = `tx-${uuid()}`;
    expect((await submit(http, w, { kind: 'BET', amount: '25.00', externalTransactionId: ext })).status).toBe(201);
    expect((await submit(http, w, { kind: 'BET', amount: '25', externalTransactionId: ext })).status).toBe(200);
  });

  test('mesma Idempotency-Key com payload diferente → 409, não replay, nada persistido', async () => {
    const ext = `tx-${uuid()}`;
    await submit(http, w, { kind: 'BET', amount: '25.00', externalTransactionId: ext });
    const res = await submit(http, w, { kind: 'BET', amount: '26.00', externalTransactionId: ext });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('IDEMPOTENCY_KEY_PAYLOAD_MISMATCH');
    expect(await ledgerCount(w.walletId)).toBe(2);
  });

  test('mesmo externalTransactionId com outra Idempotency-Key → 409 EXTERNAL_TRANSACTION_ID_CONFLICT', async () => {
    const ext = `tx-${uuid()}`;
    await submit(http, w, { kind: 'BET', amount: '25.00', externalTransactionId: ext });
    const res = await submit(http, w, { kind: 'BET', amount: '25.00', externalTransactionId: ext, idempotencyKey: 'other-key' });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('EXTERNAL_TRANSACTION_ID_CONFLICT');
  });

  test('saldo insuficiente → 422 REJECTED INSUFFICIENT_FUNDS, saldo intacto; replay também 422', async () => {
    const req = wagerBody(w, { kind: 'BET', amount: '1000.01' });
    const res = await http.post('/wagering/transactions', req.body, { 'idempotency-key': req.idempotencyKey });
    expect(res.status).toBe(422);
    expect(res.body).toEqual({
      transactionId: expect.any(String), status: 'REJECTED', balance: brl('1000.00'), failureCode: 'INSUFFICIENT_FUNDS', idempotentReplay: false,
    });
    const again = await http.post('/wagering/transactions', req.body, { 'idempotency-key': req.idempotencyKey });
    expect(again.status).toBe(422);
    expect(again.body.idempotentReplay).toBe(true);
    expect(await ledgerCount(w.walletId)).toBe(1);
    expect(await eventTypes()).toEqual(['WagerTransactionRejected']);
  });
});

describe('WIN, LOSS, REFUND, ROLLBACK', () => {
  let w: TestWallet;
  beforeEach(async () => {
    w = await createWallet(http, '100.00');
  });

  test('WIN credita', async () => {
    const res = await submit(http, w, { kind: 'WIN', amount: '50.00' });
    expect(res.status).toBe(201);
    expect(res.body.balance).toEqual(brl('150.00'));
  });

  test('LOSS → 201 sem mover saldo, sem lançamento, só WagerTransactionProcessed', async () => {
    const res = await submit(http, w, { kind: 'LOSS', amount: '10.00' });
    expect(res.status).toBe(201);
    expect(res.body.balance).toEqual(brl('100.00'));
    expect(await ledgerCount(w.walletId)).toBe(1);
    expect(await eventTypes()).toEqual(['WagerTransactionProcessed']);
    expect((await http.get(`/wallets/${w.walletId}`)).body.version).toBe(1);
  });

  test('REFUND de BET → 201; segundo REFUND → 422 ALREADY_REVERSED', async () => {
    const bet = `bet-${uuid()}`;
    await submit(http, w, { kind: 'BET', amount: '40.00', externalTransactionId: bet });
    const refund = await submit(http, w, { kind: 'REFUND', amount: '40.00', referenceExternalTransactionId: bet });
    expect(refund.status).toBe(201);
    expect(refund.body.balance).toEqual(brl('100.00'));
    const again = await submit(http, w, { kind: 'REFUND', amount: '40.00', referenceExternalTransactionId: bet });
    expect(again.status).toBe(422);
    expect(again.body.failureCode).toBe('ALREADY_REVERSED');
  });

  test('ROLLBACK de WIN já gasto → 422 REVERSAL_WOULD_OVERDRAW', async () => {
    const win = `win-${uuid()}`;
    await submit(http, w, { kind: 'WIN', amount: '50.00', externalTransactionId: win });
    await submit(http, w, { kind: 'BET', amount: '140.00' });
    const res = await submit(http, w, { kind: 'ROLLBACK', amount: '50.00', referenceExternalTransactionId: win });
    expect(res.status).toBe(422);
    expect(res.body).toMatchObject({ failureCode: 'REVERSAL_WOULD_OVERDRAW', balance: brl('10.00') });
  });

  test('referência de outra rodada → 422 REFERENCE_MISMATCH; valor diferente → REFERENCE_AMOUNT_MISMATCH', async () => {
    const bet = `bet-${uuid()}`;
    await submit(http, w, { kind: 'BET', amount: '10.00', externalTransactionId: bet, roundId: 'r-1' });
    const mismatch = await submit(http, w, { kind: 'REFUND', amount: '10.00', referenceExternalTransactionId: bet, roundId: 'r-2' });
    expect(mismatch.body.failureCode).toBe('REFERENCE_MISMATCH');
    const amount = await submit(http, w, { kind: 'REFUND', amount: '9.00', referenceExternalTransactionId: bet, roundId: 'r-1' });
    expect(amount.body.failureCode).toBe('REFERENCE_AMOUNT_MISMATCH');
  });

  test('ROLLBACK antes da BET → 202 PENDING_REFERENCE; a chegada da BET acorda o pendente', async () => {
    const bet = `bet-${uuid()}`;
    const rbReq = wagerBody(w, { kind: 'ROLLBACK', amount: '30.00', referenceExternalTransactionId: bet });
    const rb = await http.post('/wagering/transactions', rbReq.body, { 'idempotency-key': rbReq.idempotencyKey });
    expect(rb.status).toBe(202);
    expect(rb.body).toEqual({ transactionId: expect.any(String), status: 'PENDING_REFERENCE', balance: null, idempotentReplay: false });
    expect(await eventTypes()).toEqual(['WagerTransactionPendingReference']);
    const nextAttempt = async () =>
      new Date((await exec<{ next_attempt_at: string }>(`select next_attempt_at from wager_transactions where id = ?`, [rb.body.transactionId]))[0]!.next_attempt_at).getTime();
    const scheduled = await nextAttempt();

    // replay do pendente continua 202, agora como replay
    const replay = await http.post('/wagering/transactions', rbReq.body, { 'idempotency-key': rbReq.idempotencyKey });
    expect(replay.status).toBe(202);
    expect(replay.body.idempotentReplay).toBe(true);

    const betRes = await submit(http, w, { kind: 'BET', amount: '30.00', externalTransactionId: bet });
    expect(betRes.status).toBe(201);
    const [after] = await exec<{ status: string }>(`select status from wager_transactions where id = ?`, [rb.body.transactionId]);
    expect(after!.status).toBe('PENDING_REFERENCE'); // quem aplica é o worker (fase 7)
    expect(await nextAttempt()).toBeLessThan(scheduled); // acordado: próxima tentativa antecipada
  });
});

describe('validações de wallet → 422 (auditável)', () => {
  test('wallet inexistente → WALLET_NOT_FOUND, balance null, transação persistida como REJECTED', async () => {
    const res = await submit(http, { walletId: uuid(), playerId: uuid() }, { kind: 'BET', amount: '1.00' });
    expect(res.status).toBe(422);
    expect(res.body).toMatchObject({ status: 'REJECTED', failureCode: 'WALLET_NOT_FOUND', balance: null });
    expect((await http.get(`/wagering/transactions/${res.body.transactionId}`)).body.status).toBe('REJECTED');
  });

  test('wallet de outro player → WALLET_PLAYER_MISMATCH; moeda diferente → CURRENCY_MISMATCH', async () => {
    const w = await createWallet(http, '10.00');
    expect((await submit(http, w, { kind: 'BET', amount: '1.00', playerId: uuid() })).body.failureCode).toBe('WALLET_PLAYER_MISMATCH');
    const cur = await submit(http, w, { kind: 'BET', amount: '1.00', currency: 'USD' });
    expect(cur.status).toBe(422);
    expect(cur.body).toMatchObject({ failureCode: 'CURRENCY_MISMATCH', balance: brl('10.00') });
  });
});

describe('400 — payload inválido', () => {
  let w: TestWallet;
  beforeEach(async () => {
    w = await createWallet(http, '10.00');
  });
  const post = (body: unknown, key: string | null = `k-${uuid()}`) =>
    http.post('/wagering/transactions', body, key ? { 'idempotency-key': key } : {});

  test('Idempotency-Key ausente', async () => {
    const res = await post(wagerBody(w, { kind: 'BET', amount: '1.00' }).body, null);
    expect(res.status).toBe(400);
    expect(JSON.stringify(res.body.error.details)).toContain('Idempotency-Key');
  });

  test.each([
    ['kind OPENING', { kind: 'OPENING' }],
    ['amount numérico', { money: { amount: 1, currency: 'BRL' } }],
    ['amount com 3 casas', { money: brl('1.001') }],
    ['amount negativo', { money: brl('-1.00') }],
    ['BET com valor zero', { money: brl('0.00') }],
    ['providerId reservado', { providerId: 'internal' }],
    ['BET com referência', { referenceExternalTransactionId: 'x' }],
    ['walletId não-UUID', { walletId: 'abc' }],
    ['campo extra', { extra: true }],
  ])('%s', async (_l, override) => {
    const res = await post({ ...wagerBody(w, { kind: 'BET', amount: '1.00' }).body, ...override });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toEqual(expect.any(String));
  });

  test('REFUND sem referência', async () => {
    const res = await post(wagerBody(w, { kind: 'REFUND', amount: '1.00' }).body);
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('REFERENCE_REQUIRED');
  });
});

describe('consultas', () => {
  test('GET por id interno e por (provider, externalTransactionId)', async () => {
    const w = await createWallet(http, '100.00');
    const ext = `tx-${uuid()}`;
    const res = await submit(http, w, { kind: 'BET', amount: '10.00', externalTransactionId: ext });
    const byId = await http.get(`/wagering/transactions/${res.body.transactionId}`);
    expect(byId.status).toBe(200);
    expect(byId.body).toMatchObject({
      transactionId: res.body.transactionId, providerId: 'provider-a', externalTransactionId: ext, kind: 'BET',
      money: brl('10.00'), status: 'PROCESSED', balance: brl('90.00'), failureCode: null,
    });
    const byExt = await http.get(`/providers/provider-a/wagering/transactions/${ext}`);
    expect(byExt.body).toEqual(byId.body);
  });

  test('404 e 400', async () => {
    expect((await http.get(`/wagering/transactions/${uuid()}`)).body.error.code).toBe('TRANSACTION_NOT_FOUND');
    expect((await http.get(`/providers/provider-a/wagering/transactions/nope`)).status).toBe(404);
    expect((await http.get(`/wagering/transactions/not-a-uuid`)).status).toBe(400);
  });
});
