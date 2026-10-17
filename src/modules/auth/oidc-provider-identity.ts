import { createRemoteJWKSet, errors as joseErrors, jwtVerify, type JWTVerifyGetKey } from 'jose';
import type { AppLogger } from '../../shared/application/logger';
import type { ProviderIdentity, ProviderIdentityPort, RequestCredentials } from './provider-identity';

export interface OidcConfig {
  /** ex.: http://keycloak:8080/realms/wagering */
  issuer: string;
  audience: string;
  /** default: `${issuer}/protocol/openid-connect/certs` (Keycloak) */
  jwksUri?: string;
  /** claim com o id do provedor (mapper do client no IdP) */
  providerClaim: string;
  /** tolerância de relógio */
  clockToleranceSeconds?: number;
}

/**
 * Valida bearer tokens emitidos por um IdP OIDC externo (Keycloak / Zitadel) no
 * fluxo client-credentials: assinatura via JWKS (chaves em cache, rotação
 * automática), `iss`, `aud`, `exp`/`nbf`, e exige o claim do provedor.
 * Nada de usuários/senhas locais.
 */
export class OidcProviderIdentity implements ProviderIdentityPort {
  private readonly jwks: JWTVerifyGetKey;

  constructor(
    private readonly config: OidcConfig,
    private readonly logger?: AppLogger,
    jwks?: JWTVerifyGetKey,
  ) {
    const uri = config.jwksUri ?? `${config.issuer.replace(/\/$/, '')}/protocol/openid-connect/certs`;
    this.jwks = jwks ?? createRemoteJWKSet(new URL(uri), { cooldownDuration: 30_000, cacheMaxAge: 10 * 60_000 });
  }

  async authenticate({ authorization }: RequestCredentials): Promise<ProviderIdentity | undefined> {
    const match = authorization?.match(/^Bearer\s+(\S+)$/i);
    if (!match) return undefined;
    try {
      const { payload } = await jwtVerify(match[1]!, this.jwks, {
        issuer: this.config.issuer,
        audience: this.config.audience,
        clockTolerance: this.config.clockToleranceSeconds ?? 5,
      });
      const providerId = payload[this.config.providerClaim];
      if (typeof providerId !== 'string' || providerId.length === 0) {
        this.logger?.warn('token without provider claim', { claim: this.config.providerClaim, sub: payload.sub });
        return undefined;
      }
      return { providerId, subject: payload.sub ?? providerId };
    } catch (err) {
      // token inválido/expirado → 401; JWKS inacessível também nega (fail closed)
      const reason = err instanceof joseErrors.JOSEError ? err.code : err instanceof Error ? err.message : 'unknown';
      this.logger?.warn('bearer token rejected', { reason });
      return undefined;
    }
  }
}
