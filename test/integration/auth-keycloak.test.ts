/**
 * Keycloak real (docker compose --profile auth up -d keycloak). Pulada com aviso
 * se o realm `wagering` não estiver acessível em KEYCLOAK_URL (default localhost:8080).
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { decodeJwt } from 'jose';
import type { MikroORM } from '@mikro-orm/postgresql';
import { initOrm } from '../helpers/infra';
import { migrateFresh, truncateAll, uuid } from '../helpers/db';
import { startHttpApp, type HttpTestApp } from '../helpers/http-app';
import { wagerBody } from '../helpers/wager';

const KEYCLOAK = process.env.KEYCLOAK_URL ?? 'http://localhost:8080';
const ISSUER = `${KEYCLOAK}/realms/wagering`;

async function reachable(): Promise<boolean> {
  try {
    const res = await fetch(`${ISSUER}/.well-known/openid-configuration`, { signal: AbortSignal.timeout(1_500) });
    return res.ok;
  } catch {
    return false;
  }
}

/** client-credentials grant — como um provedor real obteria o token. */
async function tokenFor(clientId: string, secret = `${clientId}-secret`): Promise<string> {
  const res = await fetch(`${ISSUER}/protocol/openid-connect/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'client_credentials', client_id: clientId, client_secret: secret }),
  });
  if (!res.ok) throw new Error(`token request failed: ${res.status} ${await res.text()}`);
  return ((await res.json()) as { access_token: string }).access_token;
}

const available = await reachable();
if (!available) console.warn(`[auth-keycloak] Keycloak indisponível em ${KEYCLOAK} — suíte PULADA. Rode \`docker compose --profile auth up -d keycloak\`.`);

describe.skipIf(!available)('Keycloak (OIDC client-credentials)', () => {
  let orm: MikroORM;
  let http: HttpTestApp;
  const saved = { AUTH_MODE: process.env.AUTH_MODE, OIDC_ISSUER: process.env.OIDC_ISSUER };

  beforeAll(async () => {
    orm = await initOrm();
    await migrateFresh(orm);
    await truncateAll(orm);
    process.env.AUTH_MODE = 'oidc';
    process.env.OIDC_ISSUER = ISSUER;
    http = await startHttpApp();
  });
  afterAll(async () => {
    await http?.close();
    await orm?.close(true);
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  test('token do realm traz provider_id e audience wagering-api', async () => {
    const claims = decodeJwt(await tokenFor('provider-a'));
    expect(claims.provider_id).toBe('provider-a');
    expect([claims.aud].flat()).toContain('wagering-api');
    expect(claims.iss).toBe(ISSUER);
  });

  test('provider-a cria wallet e aposta; provider-b não opera em nome de provider-a', async () => {
    const a = { authorization: `Bearer ${await tokenFor('provider-a')}` };
    const b = { authorization: `Bearer ${await tokenFor('provider-b')}` };
    const created = await http.post('/wallets', { playerId: uuid(), initialBalance: { amount: '100.00', currency: 'BRL' } }, a);
    expect(created.status).toBe(201);
    const w = { walletId: created.body.id, playerId: created.body.playerId };
    const req = wagerBody(w, { kind: 'BET', amount: '10.00', providerId: 'provider-a' });
    expect((await http.post('/wagering/transactions', req.body, { 'idempotency-key': req.idempotencyKey, ...b })).status).toBe(403);
    expect((await http.post('/wagering/transactions', req.body, { 'idempotency-key': req.idempotencyKey, ...a })).status).toBe(201);
  });

  test('secret errado não obtém token; sem token → 401', async () => {
    await expect(tokenFor('provider-a', 'wrong')).rejects.toThrow('token request failed');
    expect((await http.get(`/wallets/${uuid()}`)).status).toBe(401);
  });
});
