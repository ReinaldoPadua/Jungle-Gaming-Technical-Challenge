import { EntitySchema } from '@mikro-orm/core';
import { Money } from '../../../../shared/domain/money';
import type { FailureCode } from '../../domain/failure-code';
import { WagerTransaction } from '../../domain/wager-transaction';
import type { WagerTransactionKind } from '../../domain/wager-transaction-kind';
import type { WagerTransactionStatus } from '../../domain/wager-transaction-status';

export class WagerTransactionRecord {
  id!: string;
  providerId!: string;
  externalTransactionId!: string;
  idempotencyKey!: string;
  payloadHash!: string;
  walletId!: string;
  playerId!: string;
  roundId!: string;
  gameId!: string;
  kind!: WagerTransactionKind;
  amount!: string;
  currency!: string;
  referenceExternalTransactionId?: string | null;
  referenceTransactionId?: string | null;
  status!: WagerTransactionStatus;
  failureCode?: FailureCode | null;
  resultBalanceAmount?: string | null;
  resultBalanceCurrency?: string | null;
  attempts!: number;
  nextAttemptAt?: Date | null;
  correlationId?: string | null;
  processedAt?: Date | null;
  createdAt!: Date;
  updatedAt!: Date;
}

const opt = { nullable: true } as const;

export const WagerTransactionSchema = new EntitySchema<WagerTransactionRecord>({
  class: WagerTransactionRecord,
  tableName: 'wager_transactions',
  properties: {
    id: { type: 'uuid', primary: true },
    providerId: { type: 'string', length: 64 },
    externalTransactionId: { type: 'string', length: 128 },
    idempotencyKey: { type: 'string', length: 256 },
    payloadHash: { type: 'string', length: 64 },
    walletId: { type: 'uuid' },
    playerId: { type: 'uuid' },
    roundId: { type: 'string', length: 128 },
    gameId: { type: 'string', length: 128 },
    kind: { type: 'string', length: 16 },
    amount: { type: 'decimal', precision: 20, scale: 2 },
    currency: { type: 'character', length: 3 },
    referenceExternalTransactionId: { type: 'string', length: 128, ...opt },
    referenceTransactionId: { type: 'uuid', ...opt },
    status: { type: 'string', length: 24 },
    failureCode: { type: 'string', length: 48, ...opt },
    resultBalanceAmount: { type: 'decimal', precision: 20, scale: 2, ...opt },
    resultBalanceCurrency: { type: 'character', length: 3, ...opt },
    attempts: { type: 'integer' },
    nextAttemptAt: { type: 'Date', columnType: 'timestamptz', ...opt },
    correlationId: { type: 'string', length: 128, ...opt },
    processedAt: { type: 'Date', columnType: 'timestamptz', ...opt },
    createdAt: { type: 'Date', columnType: 'timestamptz' },
    updatedAt: { type: 'Date', columnType: 'timestamptz' },
  },
});

const orUndefined = <T>(v: T | null | undefined): T | undefined => (v === null ? undefined : v);

export const WagerTransactionMapper = {
  toDomain(r: WagerTransactionRecord): WagerTransaction {
    return WagerTransaction.rehydrate({
      id: r.id,
      providerId: r.providerId,
      externalTransactionId: r.externalTransactionId,
      idempotencyKey: r.idempotencyKey,
      payloadHash: r.payloadHash,
      walletId: r.walletId,
      playerId: r.playerId,
      roundId: r.roundId,
      gameId: r.gameId,
      kind: r.kind,
      money: Money.from({ amount: r.amount, currency: r.currency }),
      referenceExternalTransactionId: orUndefined(r.referenceExternalTransactionId),
      createdAt: r.createdAt,
      status: r.status,
      referenceTransactionId: orUndefined(r.referenceTransactionId),
      failureCode: orUndefined(r.failureCode),
      resultBalance:
        r.resultBalanceAmount != null && r.resultBalanceCurrency != null
          ? Money.from({ amount: r.resultBalanceAmount, currency: r.resultBalanceCurrency })
          : undefined,
      attempts: r.attempts,
      nextAttemptAt: orUndefined(r.nextAttemptAt),
      processedAt: orUndefined(r.processedAt),
      updatedAt: r.updatedAt,
    });
  },

  toRecord(
    tx: WagerTransaction,
    target: WagerTransactionRecord = new WagerTransactionRecord(),
    meta: { correlationId?: string } = {},
  ): WagerTransactionRecord {
    const s = tx.toState();
    target.id = s.id;
    target.providerId = s.providerId;
    target.externalTransactionId = s.externalTransactionId;
    target.idempotencyKey = s.idempotencyKey;
    target.payloadHash = s.payloadHash;
    target.walletId = s.walletId;
    target.playerId = s.playerId;
    target.roundId = s.roundId;
    target.gameId = s.gameId;
    target.kind = s.kind;
    target.amount = s.money.amount;
    target.currency = s.money.currency;
    target.referenceExternalTransactionId = s.referenceExternalTransactionId ?? null;
    target.referenceTransactionId = s.referenceTransactionId ?? null;
    target.status = s.status;
    target.failureCode = s.failureCode ?? null;
    target.resultBalanceAmount = s.resultBalance?.amount ?? null;
    target.resultBalanceCurrency = s.resultBalance?.currency ?? null;
    target.attempts = s.attempts;
    target.nextAttemptAt = s.nextAttemptAt ?? null;
    target.processedAt = s.processedAt ?? null;
    target.createdAt = s.createdAt;
    target.updatedAt = s.updatedAt;
    if (meta.correlationId !== undefined) target.correlationId = meta.correlationId;
    else if (target.correlationId === undefined) target.correlationId = null;
    return target;
  },
};
