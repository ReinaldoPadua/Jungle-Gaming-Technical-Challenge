/** Mensagem recebida de uma fila (abstração mínima sobre o SQS). */
export interface QueueMessage {
  /** id atribuído pelo broker (não confundir com o messageId do envelope) */
  brokerMessageId: string;
  receiptHandle: string;
  body: string;
  /** MessageGroupId (FIFO) */
  groupId?: string;
  /** ApproximateReceiveCount — 1 na primeira entrega */
  receiveCount: number;
}

export interface DeadLetter {
  message: QueueMessage;
  reason: string;
  detail?: string;
}

/**
 * Porta de consumo. Implementada sobre o SQS (produção/LocalStack) e por uma
 * fila FIFO em memória que emula visibility timeout e redrive (testes).
 */
export interface QueueClient {
  receive(opts: { maxMessages: number; waitSeconds: number; visibilityTimeoutSeconds: number; signal?: AbortSignal }): Promise<QueueMessage[]>;
  /** Remove a mensagem (ack). Só depois do COMMIT. */
  ack(message: QueueMessage): Promise<void>;
  changeVisibility(message: QueueMessage, seconds: number): Promise<void>;
  /** Envia para a DLQ e remove da fila principal. */
  deadLetter(letter: DeadLetter): Promise<void>;
}

export const QUEUE_CLIENT = Symbol('QUEUE_CLIENT');
