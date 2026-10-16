import type { OutboxMessage } from '../domain/outbox-message';

export interface OutboxRepository {
  enqueue(...messages: OutboxMessage[]): Promise<void>;
}
