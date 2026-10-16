import { createHash } from 'node:crypto';
import { canonicalJson } from '../../../shared/canonical-json';
import type { Money } from '../../../shared/domain/money';
import type { WagerTransactionKind } from '../domain/wager-transaction-kind';

/** Subconjunto de campos de negócio que define a identidade do payload. */
export interface WagerBusinessPayload {
  providerId: string;
  externalTransactionId: string;
  playerId: string;
  walletId: string;
  roundId: string;
  gameId: string;
  kind: WagerTransactionKind;
  money: Money;
  referenceExternalTransactionId?: string;
}

/**
 * payloadHash = hex(SHA-256(canonicalJson(subconjunto de negócio))).
 *
 * - Fora do hash: header Idempotency-Key, messageId, occurredAt, correlationId e
 *   qualquer metadado de transporte.
 * - `money.amount` entra NORMALIZADO (escala 2): "25", "25.0" e "25.00" são o mesmo payload.
 * - Campos opcionais ausentes são omitidos (não viram null).
 */
export function computePayloadHash(p: WagerBusinessPayload): string {
  const canonical = canonicalJson({
    providerId: p.providerId,
    externalTransactionId: p.externalTransactionId,
    playerId: p.playerId,
    walletId: p.walletId,
    roundId: p.roundId,
    gameId: p.gameId,
    kind: p.kind,
    money: p.money.toJSON(),
    referenceExternalTransactionId: p.referenceExternalTransactionId,
  });
  return createHash('sha256').update(canonical, 'utf8').digest('hex');
}
