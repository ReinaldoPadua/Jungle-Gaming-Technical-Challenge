import { Global, Module } from '@nestjs/common';
import { ENV, type Env } from '../../config/env';
import { ProviderAuthGuard } from './auth.guard';
import { anonymousProviderIdentity, PROVIDER_IDENTITY } from './provider-identity';

@Global()
@Module({
  providers: [
    {
      provide: PROVIDER_IDENTITY,
      inject: [ENV],
      useFactory: (env: Env) => {
        if (env.AUTH_MODE === 'none') return anonymousProviderIdentity;
        throw new Error(`AUTH_MODE=${env.AUTH_MODE} is not implemented (see ARCHITECTURE.md §9)`);
      },
    },
    ProviderAuthGuard,
  ],
  exports: [PROVIDER_IDENTITY, ProviderAuthGuard],
})
export class AuthModule {}
