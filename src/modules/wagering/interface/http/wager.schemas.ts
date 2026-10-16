import { z } from 'zod';
import { MoneySchema, UuidParam } from '../../../../interface/http/schemas';
import { WagerTransactionKind } from '../../domain/wager-transaction-kind';

const ExternalId = z.string().min(1).max(128).regex(/^[\w.:@\-/]+$/, 'only letters, digits and . : @ - _ /');

export const ProviderId = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-z0-9][a-z0-9._-]*$/i, 'only letters, digits and . _ -');

/** OPENING não está aqui: é interno e nunca aceito na entrada. */
export const ExternalKind = z.enum([
  WagerTransactionKind.Bet,
  WagerTransactionKind.Win,
  WagerTransactionKind.Loss,
  WagerTransactionKind.Refund,
  WagerTransactionKind.Rollback,
]);

export const WagerTransactionBody = z
  .object({
    providerId: ProviderId,
    externalTransactionId: ExternalId,
    playerId: UuidParam,
    walletId: UuidParam,
    roundId: ExternalId,
    gameId: ExternalId,
    kind: ExternalKind,
    money: MoneySchema,
    referenceExternalTransactionId: ExternalId.optional(),
  })
  .strict();

export type WagerTransactionBody = z.infer<typeof WagerTransactionBody>;

export const IdempotencyKeyHeader = z
  .string({ required_error: 'Idempotency-Key header is required' })
  .min(1, 'Idempotency-Key header is required')
  .max(256)
  .regex(/^[\x21-\x7e]+$/, 'Idempotency-Key must be printable ASCII without spaces');

export { ExternalId };
