import { InvariantViolationError } from '../../../shared/domain/errors';
import type { Wallet } from '../../wallet/domain/wallet';
import type { WalletLedgerEntry } from '../../wallet/domain/wallet-ledger-entry';
import { InsufficientFundsError } from '../../wallet/domain/wallet.errors';
import { FailureCode } from './failure-code';
import type { ReferenceRetryPolicy } from './reference-retry-policy';
import { evaluateReference } from './reversal-policy';
import type { WagerTransaction } from './wager-transaction';
import { WagerTransactionKind } from './wager-transaction-kind';

export interface SettlementInput {
  readonly tx: WagerTransaction;
  /** wallet carregada sob lock; undefined se não existe */
  readonly wallet: Wallet | undefined;
  /** referência resolvida por (providerId, referenceExternalTransactionId), se houver */
  readonly reference: WagerTransaction | undefined;
  /** transações que já referenciam `reference` */
  readonly reversalsOfReference: readonly WagerTransaction[];
  /** id pré-gerado para o lançamento, caso a operação mova saldo */
  readonly ledgerEntryId: string;
  readonly now: Date;
  readonly retryPolicy: ReferenceRetryPolicy;
}

export type SettlementOutcome =
  | { readonly type: 'processed'; readonly entry: WalletLedgerEntry | undefined }
  | { readonly type: 'rejected'; readonly code: FailureCode }
  | { readonly type: 'pending_reference' };

/**
 * Regras de negócio de BET / WIN / LOSS / REFUND / ROLLBACK num só lugar,
 * sem I/O. O use case carrega o estado (sob lock), chama `settle` e persiste
 * o que mudou. `tx` e `wallet` são mutados; o retorno descreve o desfecho.
 */
export function settle(input: SettlementInput): SettlementOutcome {
  const { tx, wallet, reference, now } = input;
  if (tx.isTerminal()) throw new InvariantViolationError(`transaction ${tx.id} is already ${tx.status}`);

  const rejectWith = (code: FailureCode): SettlementOutcome => {
    tx.reject(code, now, wallet?.balance);
    return { type: 'rejected', code };
  };

  // 1. wallet
  if (!wallet) return rejectWith(FailureCode.WalletNotFound);
  if (wallet.id !== tx.walletId) throw new InvariantViolationError('settle() received a different wallet');
  if (wallet.playerId !== tx.playerId) return rejectWith(FailureCode.WalletPlayerMismatch);
  if (wallet.currency !== tx.money.currency) return rejectWith(FailureCode.CurrencyMismatch);

  // 2. referência (obrigatória em REFUND/ROLLBACK, opcional em WIN/LOSS)
  if (tx.hasReference()) {
    const check = reference ? evaluateReference(tx, reference, input.reversalsOfReference) : { outcome: 'wait' as const };
    if (check.outcome === 'reject') return rejectWith(check.code);
    if (check.outcome === 'wait') {
      if (tx.isReferenceWaitExhausted(now, input.retryPolicy)) return rejectWith(FailureCode.ReferenceNotFound);
      tx.markPendingReference(now, input.retryPolicy);
      return { type: 'pending_reference' };
    }
  }

  // 3. LOSS: registra o resultado sem mover saldo nem gerar ledger
  if (!tx.affectsBalance()) {
    tx.markProcessed(reference?.id, now, wallet.balance);
    return { type: 'processed', entry: undefined };
  }

  // 4. movimentação
  const direction = tx.ledgerDirectionFor(reference);
  let entry: WalletLedgerEntry;
  try {
    entry = wallet.move(direction, { entryId: input.ledgerEntryId, transactionId: tx.id, money: tx.money, at: now });
  } catch (err) {
    if (!(err instanceof InsufficientFundsError)) throw err;
    // Aposta sem saldo e reversão que estouraria o saldo são situações
    // operacionais diferentes: códigos distintos.
    return rejectWith(
      tx.kind === WagerTransactionKind.Bet ? FailureCode.InsufficientFunds : FailureCode.ReversalWouldOverdraw,
    );
  }

  tx.markProcessed(reference?.id, now, wallet.balance);
  return { type: 'processed', entry };
}
