import type { EventContext } from '../../../shared/events/integration-event';
import { IntegrationEvent } from '../../../shared/events/integration-event';
import type { MoneyProps } from '../../../shared/domain/money';
import type { LedgerDirection } from '../../wallet/domain/ledger-direction';
import type { Wallet } from '../../wallet/domain/wallet';
import type { WalletLedgerEntry } from '../../wallet/domain/wallet-ledger-entry';
import type { FailureCode } from './failure-code';
import type { WagerTransaction } from './wager-transaction';
import type { WagerTransactionKind } from './wager-transaction-kind';
import { WagerTransactionStatus } from './wager-transaction-status';
import { InvariantViolationError } from '../../../shared/domain/errors';

/** Campos comuns aos eventos de transação. */
export interface WagerTransactionRef {
  transactionId: string;
  providerId: string;
  externalTransactionId: string;
  walletId: string;
  playerId: string;
  roundId: string;
  gameId: string;
  kind: WagerTransactionKind;
  money: MoneyProps;
  referenceExternalTransactionId?: string;
}

const refOf = (tx: WagerTransaction): WagerTransactionRef => ({
  transactionId: tx.id,
  providerId: tx.providerId,
  externalTransactionId: tx.externalTransactionId,
  walletId: tx.walletId,
  playerId: tx.playerId,
  roundId: tx.roundId,
  gameId: tx.gameId,
  kind: tx.kind,
  money: tx.money.toJSON(),
  ...(tx.referenceExternalTransactionId !== undefined
    ? { referenceExternalTransactionId: tx.referenceExternalTransactionId }
    : {}),
});

const assertStatus = (tx: WagerTransaction, expected: WagerTransactionStatus, event: string) => {
  if (tx.status !== expected) throw new InvariantViolationError(`${event} requires status ${expected}, got ${tx.status}`);
};

// ------------------------------------------------------------------ Processed

export interface WagerTransactionProcessedData extends WagerTransactionRef {
  referenceTransactionId?: string;
  balanceAfter: MoneyProps;
  processedAt: string;
}

/** Qualquer transação aplicada — inclusive LOSS (que não move saldo). */
export class WagerTransactionProcessed extends IntegrationEvent<WagerTransactionProcessedData> {
  readonly eventType = 'WagerTransactionProcessed';
  readonly version = 1;

  static from(tx: WagerTransaction, ctx: EventContext): WagerTransactionProcessed {
    assertStatus(tx, WagerTransactionStatus.Processed, 'WagerTransactionProcessed');
    return new WagerTransactionProcessed({
      ...ctx,
      aggregateId: tx.walletId,
      data: {
        ...refOf(tx),
        ...(tx.referenceTransactionId !== undefined ? { referenceTransactionId: tx.referenceTransactionId } : {}),
        balanceAfter: tx.resultBalance!.toJSON(),
        processedAt: tx.processedAt!.toISOString(),
      },
    });
  }
}

// ------------------------------------------------------------------- Rejected

export interface WagerTransactionRejectedData extends WagerTransactionRef {
  failureCode: FailureCode;
}

export class WagerTransactionRejected extends IntegrationEvent<WagerTransactionRejectedData> {
  readonly eventType = 'WagerTransactionRejected';
  readonly version = 1;

  static from(tx: WagerTransaction, ctx: EventContext): WagerTransactionRejected {
    assertStatus(tx, WagerTransactionStatus.Rejected, 'WagerTransactionRejected');
    return new WagerTransactionRejected({
      ...ctx,
      aggregateId: tx.walletId,
      data: { ...refOf(tx), failureCode: tx.failureCode! },
    });
  }
}

// ----------------------------------------------------------- PendingReference

export interface WagerTransactionPendingReferenceData extends WagerTransactionRef {
  attempts: number;
  nextAttemptAt: string;
}

export class WagerTransactionPendingReference extends IntegrationEvent<WagerTransactionPendingReferenceData> {
  readonly eventType = 'WagerTransactionPendingReference';
  readonly version = 1;

  static from(tx: WagerTransaction, ctx: EventContext): WagerTransactionPendingReference {
    assertStatus(tx, WagerTransactionStatus.PendingReference, 'WagerTransactionPendingReference');
    return new WagerTransactionPendingReference({
      ...ctx,
      aggregateId: tx.walletId,
      data: { ...refOf(tx), attempts: tx.attempts, nextAttemptAt: tx.nextAttemptAt!.toISOString() },
    });
  }
}

// ------------------------------------------------------- WalletBalanceChanged

export interface WalletBalanceChangedData {
  walletId: string;
  transactionId: string;
  direction: LedgerDirection;
  money: MoneyProps;
  balanceBefore: MoneyProps;
  balanceAfter: MoneyProps;
  walletVersion: number;
}

/** Somente quando o saldo muda (há lançamento). */
export class WalletBalanceChanged extends IntegrationEvent<WalletBalanceChangedData> {
  readonly eventType = 'WalletBalanceChanged';
  readonly version = 1;

  static from(wallet: Wallet, entry: WalletLedgerEntry, ctx: EventContext): WalletBalanceChanged {
    if (entry.walletId !== wallet.id) throw new InvariantViolationError('ledger entry belongs to another wallet');
    return new WalletBalanceChanged({
      ...ctx,
      aggregateId: wallet.id,
      data: {
        walletId: wallet.id,
        transactionId: entry.transactionId,
        direction: entry.direction,
        money: entry.money.toJSON(),
        balanceBefore: entry.balanceBefore.toJSON(),
        balanceAfter: entry.balanceAfter.toJSON(),
        walletVersion: entry.sequence,
      },
    });
  }
}
