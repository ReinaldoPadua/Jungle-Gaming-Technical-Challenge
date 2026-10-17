/**
 * Ponto de extensão de autenticação (seção 2 do desafio).
 *
 * A autenticação NÃO está implementada neste desafio (decisão documentada em
 * ARCHITECTURE.md §9). O desenho adotado é: provedores autenticam via OIDC
 * client-credentials num IdP externo (Keycloak/Zitadel); o token traz o claim
 * `provider_id`; um adapter `OidcProviderIdentity` validaria o JWT (JWKS) e o
 * guard abaixo exigiria `provider_id == body.providerId`.
 */
export interface ProviderIdentity {
  /** undefined = autenticação desligada (modo `none`) */
  providerId?: string;
  subject: string;
}

export interface RequestCredentials {
  authorization?: string;
}

export interface ProviderIdentityPort {
  /** @returns identidade, ou undefined se as credenciais forem inválidas/ausentes */
  authenticate(credentials: RequestCredentials): Promise<ProviderIdentity | undefined>;
}

export const PROVIDER_IDENTITY = Symbol('PROVIDER_IDENTITY');

/** Modo `none`: aceita tudo, sem identidade de provedor. */
export const anonymousProviderIdentity: ProviderIdentityPort = {
  authenticate: async () => ({ subject: 'anonymous' }),
};
