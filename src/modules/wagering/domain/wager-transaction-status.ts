export enum WagerTransactionStatus {
  /** aceita, ainda não aplicada */
  Pending = 'PENDING',
  /** aguardando a transação referenciada */
  PendingReference = 'PENDING_REFERENCE',
  /** aplicada (terminal) */
  Processed = 'PROCESSED',
  /** violação de regra de negócio (terminal) */
  Rejected = 'REJECTED',
  /** erro permanente de infraestrutura (terminal, auditável) */
  Failed = 'FAILED',
}

export const TERMINAL_STATUSES: ReadonlySet<WagerTransactionStatus> = new Set([
  WagerTransactionStatus.Processed,
  WagerTransactionStatus.Rejected,
  WagerTransactionStatus.Failed,
]);
