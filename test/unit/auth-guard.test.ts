import { describe, expect, test } from 'bun:test';
import { ForbiddenException, UnauthorizedException, type ExecutionContext } from '@nestjs/common';
import { ProviderAuthGuard } from '../../src/modules/auth/auth.guard';
import { anonymousProviderIdentity, type ProviderIdentityPort } from '../../src/modules/auth/provider-identity';

const ctx = (req: Record<string, unknown>) => {
  req.headers ??= {}; // o guard anota o PRÓPRIO objeto da requisição
  return { switchToHttp: () => ({ getRequest: () => req }) } as unknown as ExecutionContext;
};

describe('ProviderAuthGuard (ponto de extensão)', () => {
  test('modo none: deixa passar e anexa identidade anônima', async () => {
    const req: Record<string, unknown> = { body: { providerId: 'provider-a' } };
    expect(await new ProviderAuthGuard(anonymousProviderIdentity).canActivate(ctx(req))).toBe(true);
    expect(req.providerIdentity).toEqual({ subject: 'anonymous' });
  });

  const oidcLike: ProviderIdentityPort = {
    authenticate: async ({ authorization }) => (authorization === 'Bearer good' ? { subject: 'svc', providerId: 'provider-a' } : undefined),
  };

  test('com identidade: credencial inválida → 401', async () => {
    await expect(new ProviderAuthGuard(oidcLike).canActivate(ctx({ headers: { authorization: 'Bearer bad' } }))).rejects.toThrow(UnauthorizedException);
  });

  test('com identidade: só opera em nome do próprio provedor (body ou path) → senão 403', async () => {
    const guard = new ProviderAuthGuard(oidcLike);
    const auth = { authorization: 'Bearer good' };
    expect(await guard.canActivate(ctx({ headers: auth, body: { providerId: 'provider-a' } }))).toBe(true);
    await expect(guard.canActivate(ctx({ headers: auth, body: { providerId: 'provider-b' } }))).rejects.toThrow(ForbiddenException);
    await expect(guard.canActivate(ctx({ headers: auth, params: { providerId: 'provider-b' } }))).rejects.toThrow(ForbiddenException);
  });
});
