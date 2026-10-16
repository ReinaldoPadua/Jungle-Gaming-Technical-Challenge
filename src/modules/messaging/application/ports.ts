import type { OutboxMessage } from '../domain/outbox-message';

export interface OutboxRepository {
  enqueue(...messages: OutboxMessage[]): Promise<void>;
}

/** Mensagem da outbox reservada (lease) por um publisher. */
export interface ClaimedOutboxMessage {
  message: OutboxMessage;
  lockedUntil: Date;
}

/**
 * Operações do publisher. Cada uma é um comando SQL autocontido (autocommit):
 * o publisher nunca segura uma transação aberta enquanto fala com o broker.
 */
export interface OutboxStore {
  /**
   * Reserva até `limit` mensagens pendentes e vencidas cujo lease expirou,
   * com FOR UPDATE SKIP LOCKED: publishers concorrentes nunca pegam a mesma
   * mensagem ao mesmo tempo; um publisher morto perde o lease após `leaseMs`.
   */
  claim(params: { owner: string; limit: number; leaseMs: number; now: Date }): Promise<ClaimedOutboxMessage[]>;
  /** Marca como publicadas as que ainda não estavam (idempotente). */
  markPublished(ids: string[], now: Date): Promise<number>;
  /** Persiste o reagendamento calculado pelo domínio e libera o lease. */
  reschedule(message: OutboxMessage, error: string): Promise<void>;
  stats(now: Date): Promise<{ pending: number; oldestAgeSeconds: number }>;
}

export interface PublishResult {
  id: string;
  ok: boolean;
  error?: string;
}

/** Broker de eventos de integração (SQS na infraestrutura). */
export interface EventPublisher {
  /** Publica os envelopes; o resultado é por mensagem (falhas parciais são normais). */
  publish(messages: OutboxMessage[]): Promise<PublishResult[]>;
}

export const OUTBOX_STORE = Symbol('OUTBOX_STORE');
export const EVENT_PUBLISHER = Symbol('EVENT_PUBLISHER');
