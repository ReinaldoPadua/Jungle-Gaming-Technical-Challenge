import type { MoneyProps } from '../../../shared/domain/money';
import type { FailureCode } from '../domain/failure-code';
import type { WagerTransaction } from '../domain/wager-transaction';
import type { WagerTransactionKind } from '../domain/wager-transaction-kind';
import type { WagerTransactionStatus } from '../domain/wager-transaction-status';

/** Resposta de POST /wagering/transactions (e do consumidor SQS). */
export interface WagerResult {
  transactionId: string;
  status: WagerTransactionStatus;
  /** saldo observado no momento da decisão (null se não há wallet ou ainda pendente) */
  balance: MoneyProps | null;
  failureCode?: FailureCode;
  idempotentReplay: boolean;
}

export const toWagerResult = (tx: WagerTransaction, idempotentReplay: boolean): WagerResult => ({
  transactionId: tx.id,
  status: tx.status,
  balance: tx.resultBalance?.toJSON() ?? null,
  ...(tx.failureCode !== undefined ? { failureCode: tx.failureCode } : {}),
  idempotentReplay,
});

export interface WagerTransactionView {
  transactionId: string;
  providerId: string;
  externalTransactionId: string;
  idempotencyKey: string;
  walletId: string;
  playerId: string;
  roundId: string;
  gameId: string;
  kind: WagerTransactionKind;
  money: MoneyProps;
  referenceExternalTransactionId: string | null;
  referenceTransactionId: string | null;
  status: WagerTransactionStatus;
  failureCode: FailureCode | null;
  balance: MoneyProps | null;
  attempts: number;
  nextAttemptAt: string | null;
  createdAt: string;
  processedAt: string | null;
}

export const toWagerTransactionView = (tx: WagerTransaction): WagerTransactionView => ({
  transactionId: tx.id,
  providerId: tx.providerId,
  externalTransactionId: tx.externalTransactionId,
  idempotencyKey: tx.idempotencyKey,
  walletId: tx.walletId,
  playerId: tx.playerId,
  roundId: tx.roundId,
  gameId: tx.gameId,
  kind: tx.kind,
  money: tx.money.toJSON(),
  referenceExternalTransactionId: tx.referenceExternalTransactionId ?? null,
  referenceTransactionId: tx.referenceTransactionId ?? null,
  status: tx.status,
  failureCode: tx.failureCode ?? null,
  balance: tx.resultBalance?.toJSON() ?? null,
  attempts: tx.attempts,
  nextAttemptAt: tx.nextAttemptAt?.toISOString() ?? null,
  createdAt: tx.createdAt.toISOString(),
  processedAt: tx.processedAt?.toISOString() ?? null,
});
