import { exportJWK, generateKeyPair, SignJWT, type JWK, type KeyLike } from 'jose';

/** IdP mínimo para testes: publica um JWKS real e assina tokens RS256. */
export async function startFakeIdp() {
  const { publicKey, privateKey } = await generateKeyPair('RS256');
  const jwk: JWK = { ...(await exportJWK(publicKey)), kid: 'test-key', alg: 'RS256', use: 'sig' };
  const server = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    fetch: (req) =>
      new URL(req.url).pathname.endsWith('/protocol/openid-connect/certs')
        ? Response.json({ keys: [jwk] })
        : new Response('not found', { status: 404 }),
  });
  const issuer = `http://127.0.0.1:${server.port}/realms/wagering`;

  const sign = async (
    claims: Record<string, unknown>,
    opts: { issuer?: string; audience?: string; expiresIn?: string | number; key?: KeyLike } = {},
  ) =>
    new SignJWT(claims)
      .setProtectedHeader({ alg: 'RS256', kid: 'test-key' })
      .setIssuer(opts.issuer ?? issuer)
      .setAudience(opts.audience ?? 'wagering-api')
      .setSubject(`service-account-${String(claims.provider_id ?? 'x')}`)
      .setIssuedAt()
      .setExpirationTime(opts.expiresIn ?? '5m')
      .sign(opts.key ?? privateKey);

  return { issuer, sign, stop: () => server.stop(true) };
}
