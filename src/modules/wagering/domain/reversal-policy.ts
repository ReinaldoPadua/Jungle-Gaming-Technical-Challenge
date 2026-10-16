import { FailureCode } from './failure-code';
import type { WagerTransaction } from './wager-transaction';
import { WagerTransactionKind as Kind } from './wager-transaction-kind';
import { WagerTransactionStatus as Status } from './wager-transaction-status';

export type ReferenceCheck =
  | { readonly outcome: 'ok' }
  /** a referência existe mas ainda não é terminal: continuar aguardando */
  | { readonly outcome: 'wait' }
  | { readonly outcome: 'reject'; readonly code: FailureCode };

/** Quais kinds cada operação pode referenciar. */
const ALLOWED_REFERENCE_KINDS: Readonly<Partial<Record<Kind, ReadonlySet<Kind>>>> = {
  [Kind.Refund]: new Set([Kind.Bet]),
  [Kind.Rollback]: new Set([Kind.Bet, Kind.Win, Kind.Refund]),
  [Kind.Win]: new Set([Kind.Bet]),
  [Kind.Loss]: new Set([Kind.Bet]),
};

const OK: ReferenceCheck = Object.freeze({ outcome: 'ok' });
const WAIT: ReferenceCheck = Object.freeze({ outcome: 'wait' });
const reject = (code: FailureCode): ReferenceCheck => ({ outcome: 'reject', code });

/**
 * Serviço de domínio puro que decide se `tx` pode usar `reference`.
 *
 * Interpretações adotadas (documentadas no ARCHITECTURE.md):
 * - A referência precisa ter o mesmo provider, player, wallet, moeda e rodada.
 * - Uma transação só pode ser revertida UMA vez, por qualquer tipo de reversão:
 *   uma BET reembolsada não aceita ROLLBACK e vice-versa. Isso evita crédito
 *   em dobro (REFUND + ROLLBACK da mesma BET). No banco: índice único parcial
 *   sobre reference_transaction_id para reversões PROCESSED.
 * - Reversão exige valor igual ao da referência (reversão parcial fora de escopo).
 *
 * @param reversalsOfReference transações já existentes que referenciam `reference`
 *        (lidas sob o lock da wallet, portanto estáveis durante a decisão).
 */
export function evaluateReference(
  tx: WagerTransaction,
  reference: WagerTransaction,
  reversalsOfReference: readonly WagerTransaction[],
): ReferenceCheck {
  const sameScope =
    reference.providerId === tx.providerId &&
    reference.playerId === tx.playerId &&
    reference.walletId === tx.walletId &&
    reference.roundId === tx.roundId &&
    reference.money.currency === tx.money.currency;
  if (!sameScope) return reject(FailureCode.ReferenceMismatch);

  const allowed = ALLOWED_REFERENCE_KINDS[tx.kind];
  if (!allowed?.has(reference.kind)) return reject(FailureCode.ReferenceInvalidKind);

  if (reference.status === Status.Pending || reference.status === Status.PendingReference) return WAIT;
  if (reference.status !== Status.Processed) return reject(FailureCode.ReferenceNotProcessed);

  if (!tx.isReversal()) return OK;

  if (!reference.money.equals(tx.money)) return reject(FailureCode.ReferenceAmountMismatch);

  const alreadyReversed = reversalsOfReference.some(
    (r) => r.id !== tx.id && r.isReversal() && r.status === Status.Processed,
  );
  if (alreadyReversed) return reject(FailureCode.AlreadyReversed);

  return OK;
}
