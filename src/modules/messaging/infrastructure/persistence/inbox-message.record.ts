import { EntitySchema } from '@mikro-orm/core';
import { InboxMessage } from '../../domain/inbox-message';

export class InboxMessageRecord {
  consumerName!: string;
  messageId!: string;
  payloadHash!: string;
  receivedAt!: Date;
  processedAt?: Date | null;
}

export const InboxMessageSchema = new EntitySchema<InboxMessageRecord>({
  class: InboxMessageRecord,
  tableName: 'inbox_messages',
  properties: {
    consumerName: { type: 'string', length: 64, primary: true },
    messageId: { type: 'string', length: 128, primary: true },
    payloadHash: { type: 'string', length: 64 },
    receivedAt: { type: 'Date', columnType: 'timestamptz' },
    processedAt: { type: 'Date', columnType: 'timestamptz', nullable: true },
  },
});

export const InboxMessageMapper = {
  toDomain(r: InboxMessageRecord): InboxMessage {
    return InboxMessage.rehydrate({
      consumerName: r.consumerName,
      messageId: r.messageId,
      payloadHash: r.payloadHash,
      receivedAt: r.receivedAt,
      processedAt: r.processedAt ?? undefined,
    });
  },
  toRecord(m: InboxMessage, target: InboxMessageRecord = new InboxMessageRecord()): InboxMessageRecord {
    target.consumerName = m.consumerName;
    target.messageId = m.messageId;
    target.payloadHash = m.payloadHash;
    target.receivedAt = m.receivedAt;
    target.processedAt = m.processedAt ?? null;
    return target;
  },
};
