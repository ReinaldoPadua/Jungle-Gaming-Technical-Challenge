import { ConflictError, NotFoundError } from '../../../shared/application/errors';

/** Mesma Idempotency-Key com payload de negócio diferente: conflito, nunca replay. */
export class IdempotencyKeyConflictError extends ConflictError {
  constructor(idempotencyKey: string, existingTransactionId: string) {
    super('IDEMPOTENCY_KEY_PAYLOAD_MISMATCH', 'idempotency key was already used with a different payload', {
      idempotencyKey,
      existingTransactionId,
    });
  }
}

/** (providerId, externalTransactionId) já registrado sob outra Idempotency-Key. */
export class ExternalTransactionConflictError extends ConflictError {
  constructor(providerId: string, externalTransactionId: string, existingTransactionId: string) {
    super(
      'EXTERNAL_TRANSACTION_ID_CONFLICT',
      'externalTransactionId was already submitted by this provider under a different idempotency key',
      { providerId, externalTransactionId, existingTransactionId },
    );
  }
}

export class WagerTransactionNotFoundError extends NotFoundError {
  constructor(what: string) {
    super('TRANSACTION_NOT_FOUND', `wager transaction ${what} not found`);
  }
}

/** Mesmo messageId com conteúdo diferente: mensagem corrompida/forjada — nunca processar. */
export class InboxPayloadMismatchError extends ConflictError {
  constructor(consumerName: string, messageId: string) {
    super('INBOX_PAYLOAD_MISMATCH', `message ${messageId} was already received by ${consumerName} with a different payload`, {
      consumerName,
      messageId,
    });
  }
}
