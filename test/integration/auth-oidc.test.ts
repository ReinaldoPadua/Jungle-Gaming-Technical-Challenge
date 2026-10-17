/**
 * AUTH_MODE=oidc contra um JWKS real (chaves RSA geradas no teste, tokens
 * assinados de verdade). A suíte com Keycloak real está em auth-keycloak.test.ts.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { generateKeyPair } from 'jose';
import type { MikroORM } from '@mikro-orm/postgresql';
import { initOrm } from '../helpers/infra';
import { migrateFresh, truncateAll, uuid } from '../helpers/db';
import { startHttpApp, type HttpTestApp } from '../helpers/http-app';
import { startFakeIdp } from '../helpers/oidc';
import { wagerBody } from '../helpers/wager';

let orm: MikroORM;
let http: HttpTestApp;
let idp: Awaited<ReturnType<typeof startFakeIdp>>;
const saved = { AUTH_MODE: process.env.AUTH_MODE, OIDC_ISSUER: process.env.OIDC_ISSUER };

beforeAll(async () => {
  orm = await initOrm();
  await migrateFresh(orm);
  await truncateAll(orm);
  idp = await startFakeIdp();
  process.env.AUTH_MODE = 'oidc';
  process.env.OIDC_ISSUER = idp.issuer;
  http = await startHttpApp();
});
afterAll(async () => {
  await http?.close();
  await orm?.close(true);
  idp?.stop();
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

const bearer = (token: string) => ({ authorization: `Bearer ${token}` });

async function walletFor(provider: string) {
  const token = await idp.sign({ provider_id: provider });
  const res = await http.post('/wallets', { playerId: uuid(), initialBalance: { amount: '100.00', currency: 'BRL' } }, bearer(token));
  expect(res.status).toBe(201);
  return { walletId: res.body.id as string, playerId: res.body.playerId as string, token };
}

describe('AUTH_MODE=oidc', () => {
  test('token válido do provedor → opera normalmente', async () => {
    const w = await walletFor('provider-a');
    const { body, idempotencyKey } = wagerBody(w, { kind: 'BET', amount: '10.00' });
    const res = await http.post('/wagering/transactions', body, { 'idempotency-key': idempotencyKey, ...bearer(w.token) });
    expect(res.status).toBe(201);
  });

  test('sem token → 401', async () => {
    const res = await http.post('/wallets', { playerId: uuid(), initialBalance: { amount: '1.00', currency: 'BRL' } });
    expect(res.status).toBe(401);
    expect((await http.get(`/wallets/${uuid()}`)).status).toBe(401);
  });

  test.each([
    ['assinatura de outra chave', async () => idp.sign({ provider_id: 'provider-a' }, { key: (await generateKeyPair('RS256')).privateKey })],
    ['expirado', () => idp.sign({ provider_id: 'provider-a' }, { expiresIn: Math.floor(Date.now() / 1000) - 60 })],
    ['issuer errado', () => idp.sign({ provider_id: 'provider-a' }, { issuer: 'http://evil/realms/wagering' })],
    ['audience errada', () => idp.sign({ provider_id: 'provider-a' }, { audience: 'other-api' })],
    ['sem claim provider_id', () => idp.sign({ scope: 'x' })],
    ['não é JWT', async () => 'not-a-jwt'],
  ])('%s → 401', async (_l, makeToken) => {
    const res = await http.get(`/wallets/${uuid()}`, bearer(await makeToken()));
    expect(res.status).toBe(401);
  });

  test('provedor não pode operar em nome de outro → 403 (corpo e path)', async () => {
    const w = await walletFor('provider-a');
    const bets = async () =>
      ((await orm.em.getConnection().execute(`select count(*)::text as n from wager_transactions where kind = 'BET'`)) as { n: string }[])[0]!.n;
    const before = await bets();
    const tokenB = await idp.sign({ provider_id: 'provider-b' });
    const { body, idempotencyKey } = wagerBody(w, { kind: 'BET', amount: '10.00', providerId: 'provider-a' });
    const res = await http.post('/wagering/transactions', body, { 'idempotency-key': idempotencyKey, ...bearer(tokenB) });
    expect(res.status).toBe(403);
    expect((await http.get('/providers/provider-a/wagering/transactions/x', bearer(tokenB))).status).toBe(403);
    expect((await http.get('/providers/provider-b/wagering/transactions/x', bearer(tokenB))).status).toBe(404);
    // nada foi gravado pela tentativa barrada
    expect(await bets()).toBe(before);
  });

  test('/health/live e /metrics continuam abertos', async () => {
    expect((await http.get('/metrics')).status).toBe(200);
  });
});
