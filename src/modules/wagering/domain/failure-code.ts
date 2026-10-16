/**
 * Taxonomia estável de falhas, legível por máquina. Cada código diz ao
 * provedor o que fazer: reenviar a mesma requisição não muda o resultado de
 * nenhum deles (todos são terminais) — por isso `providerAction` é o que importa.
 */
export enum FailureCode {
  // ---- saldo
  InsufficientFunds = 'INSUFFICIENT_FUNDS',
  ReversalWouldOverdraw = 'REVERSAL_WOULD_OVERDRAW',
  // ---- wallet
  WalletNotFound = 'WALLET_NOT_FOUND',
  WalletPlayerMismatch = 'WALLET_PLAYER_MISMATCH',
  CurrencyMismatch = 'CURRENCY_MISMATCH',
  // ---- referência
  ReferenceNotFound = 'REFERENCE_NOT_FOUND',
  ReferenceMismatch = 'REFERENCE_MISMATCH',
  ReferenceInvalidKind = 'REFERENCE_INVALID_KIND',
  ReferenceNotProcessed = 'REFERENCE_NOT_PROCESSED',
  ReferenceAmountMismatch = 'REFERENCE_AMOUNT_MISMATCH',
  AlreadyReversed = 'ALREADY_REVERSED',
  // ---- infraestrutura (status FAILED)
  InfraPermanentFailure = 'INFRA_PERMANENT_FAILURE',
}

export type ProviderAction =
  /** decisão definitiva; não reenviar */
  | 'GIVE_UP'
  /** payload inconsistente com o estado; corrigir e enviar com NOVA externalTransactionId */
  | 'FIX_PAYLOAD'
  /** exige investigação humana (operação/suporte) */
  | 'ESCALATE';

export interface FailureCodeInfo {
  readonly providerAction: ProviderAction;
  readonly description: string;
}

export const FAILURE_CODES: Readonly<Record<FailureCode, FailureCodeInfo>> = {
  [FailureCode.InsufficientFunds]: { providerAction: 'GIVE_UP', description: 'BET maior que o saldo disponível' },
  [FailureCode.ReversalWouldOverdraw]: {
    providerAction: 'ESCALATE',
    description: 'ROLLBACK de crédito deixaria o saldo negativo (jogador já gastou o valor)',
  },
  [FailureCode.WalletNotFound]: { providerAction: 'FIX_PAYLOAD', description: 'walletId inexistente' },
  [FailureCode.WalletPlayerMismatch]: { providerAction: 'FIX_PAYLOAD', description: 'wallet não pertence ao playerId' },
  [FailureCode.CurrencyMismatch]: { providerAction: 'FIX_PAYLOAD', description: 'moeda da operação difere da wallet' },
  [FailureCode.ReferenceNotFound]: {
    providerAction: 'ESCALATE',
    description: 'referência não chegou dentro do prazo de espera',
  },
  [FailureCode.ReferenceMismatch]: {
    providerAction: 'FIX_PAYLOAD',
    description: 'referência pertence a outro provider/player/wallet/moeda/rodada',
  },
  [FailureCode.ReferenceInvalidKind]: {
    providerAction: 'FIX_PAYLOAD',
    description: 'tipo da referência não pode ser revertido por esta operação',
  },
  [FailureCode.ReferenceNotProcessed]: {
    providerAction: 'GIVE_UP',
    description: 'referência foi rejeitada/falhou; nada a reverter',
  },
  [FailureCode.ReferenceAmountMismatch]: {
    providerAction: 'FIX_PAYLOAD',
    description: 'valor da reversão difere do valor da referência (reversão parcial não suportada)',
  },
  [FailureCode.AlreadyReversed]: { providerAction: 'GIVE_UP', description: 'referência já foi revertida' },
  [FailureCode.InfraPermanentFailure]: {
    providerAction: 'ESCALATE',
    description: 'falha permanente de infraestrutura ao processar',
  },
};
