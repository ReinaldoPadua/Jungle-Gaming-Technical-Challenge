import { Global, Module } from '@nestjs/common';
import { ENV, type Env } from '../../config/env';
import { APP_LOGGER, type AppLogger } from '../../shared/application/logger';
import { ProviderAuthGuard } from './auth.guard';
import { OidcProviderIdentity } from './oidc-provider-identity';
import { anonymousProviderIdentity, PROVIDER_IDENTITY } from './provider-identity';

@Global()
@Module({
  providers: [
    {
      provide: PROVIDER_IDENTITY,
      inject: [ENV, APP_LOGGER],
      useFactory: (env: Env, logger: AppLogger) => {
        if (env.AUTH_MODE === 'none') return anonymousProviderIdentity;
        if (!env.OIDC_ISSUER) throw new Error('AUTH_MODE=oidc requires OIDC_ISSUER');
        return new OidcProviderIdentity(
          { issuer: env.OIDC_ISSUER, audience: env.OIDC_AUDIENCE, jwksUri: env.OIDC_JWKS_URI, providerClaim: env.OIDC_PROVIDER_CLAIM },
          logger,
        );
      },
    },
    ProviderAuthGuard,
  ],
  exports: [PROVIDER_IDENTITY, ProviderAuthGuard],
})
export class AuthModule {}
