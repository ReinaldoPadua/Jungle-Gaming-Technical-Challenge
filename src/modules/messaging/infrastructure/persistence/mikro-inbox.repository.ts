import type { EntityManager } from '@mikro-orm/postgresql';
import type { InboxReceipt, InboxRepository } from '../../application/ports';
import { InboxMessage } from '../../domain/inbox-message';
import { InboxMessageMapper, InboxMessageRecord } from './inbox-message.record';

export class MikroInboxRepository implements InboxRepository {
  constructor(private readonly em: EntityManager) {}

  async receive(message: InboxMessage): Promise<InboxReceipt> {
    const rows = await this.em.execute<{ message_id: string }[]>(
      `insert into inbox_messages (consumer_name, message_id, payload_hash, received_at, processed_at)
       values (?, ?, ?, ?, null)
       on conflict (consumer_name, message_id) do nothing
       returning message_id`,
      [message.consumerName, message.messageId, message.payloadHash, message.receivedAt],
    );
    if (rows.length === 1) return { kind: 'new', message };
    const existing = await this.em.findOneOrFail(
      InboxMessageRecord,
      { consumerName: message.consumerName, messageId: message.messageId },
      { refresh: true },
    );
    return { kind: 'duplicate', existing: InboxMessageMapper.toDomain(existing) };
  }

  async markProcessed(message: InboxMessage): Promise<void> {
    await this.em.execute(
      `update inbox_messages set processed_at = ? where consumer_name = ? and message_id = ? and processed_at is null`,
      [message.processedAt, message.consumerName, message.messageId],
    );
  }
}
