import type { EntityManager } from '@mikro-orm/postgresql';
import type { OutboxRepository } from '../../application/ports';
import type { OutboxMessage } from '../../domain/outbox-message';
import { OutboxMessageMapper } from './outbox-message.record';

export class MikroOutboxRepository implements OutboxRepository {
  constructor(private readonly em: EntityManager) {}

  async enqueue(...messages: OutboxMessage[]): Promise<void> {
    for (const m of messages) this.em.persist(OutboxMessageMapper.toRecord(m));
    await this.em.flush();
  }
}
