import { type CanActivate, type ExecutionContext, ForbiddenException, Inject, Injectable, UnauthorizedException } from '@nestjs/common';
import { PROVIDER_IDENTITY, type ProviderIdentityPort } from './provider-identity';

interface GuardedRequest {
  headers: Record<string, string | string[] | undefined>;
  body?: { providerId?: unknown };
  params?: { providerId?: unknown };
  providerIdentity?: unknown;
}

/**
 * Guard aplicado aos controllers de negócio (não a /health nem /metrics).
 * Com identidade de provedor, só permite operar em nome do próprio provedor.
 * No modo `none` (padrão deste desafio) é efetivamente um no-op.
 */
@Injectable()
export class ProviderAuthGuard implements CanActivate {
  constructor(@Inject(PROVIDER_IDENTITY) private readonly identities: ProviderIdentityPort) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<GuardedRequest>();
    const header = req.headers.authorization;
    const identity = await this.identities.authenticate({ authorization: Array.isArray(header) ? header[0] : header });
    if (!identity) throw new UnauthorizedException('invalid or missing credentials');
    req.providerIdentity = identity;
    if (identity.providerId !== undefined) {
      const claimed = req.body?.providerId ?? req.params?.providerId;
      if (claimed !== undefined && claimed !== identity.providerId) {
        throw new ForbiddenException('cannot act on behalf of another provider');
      }
    }
    return true;
  }
}
