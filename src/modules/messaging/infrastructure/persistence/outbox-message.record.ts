import { EntitySchema } from '@mikro-orm/core';
import { OutboxMessage } from '../../domain/outbox-message';

export class OutboxMessageRecord {
  id!: string;
  aggregateId!: string;
  eventType!: string;
  payload!: Record<string, unknown>;
  occurredAt!: Date;
  attempts!: number;
  nextAttemptAt!: Date;
  /** lease do publisher (fase 5) — não faz parte do domínio */
  lockedUntil?: Date | null;
  lockedBy?: string | null;
  publishedAt?: Date | null;
  lastError?: string | null;
}

export const OutboxMessageSchema = new EntitySchema<OutboxMessageRecord>({
  class: OutboxMessageRecord,
  tableName: 'outbox_messages',
  properties: {
    id: { type: 'uuid', primary: true },
    aggregateId: { type: 'string', length: 128 },
    eventType: { type: 'string', length: 64 },
    payload: { type: 'json' },
    occurredAt: { type: 'Date', columnType: 'timestamptz' },
    attempts: { type: 'integer' },
    nextAttemptAt: { type: 'Date', columnType: 'timestamptz' },
    lockedUntil: { type: 'Date', columnType: 'timestamptz', nullable: true },
    lockedBy: { type: 'string', length: 128, nullable: true },
    publishedAt: { type: 'Date', columnType: 'timestamptz', nullable: true },
    lastError: { type: 'text', nullable: true },
  },
});

export const OutboxMessageMapper = {
  toDomain(r: OutboxMessageRecord): OutboxMessage {
    return OutboxMessage.rehydrate({
      id: r.id,
      aggregateId: r.aggregateId,
      eventType: r.eventType,
      payload: r.payload,
      occurredAt: r.occurredAt,
      attempts: r.attempts,
      nextAttemptAt: r.nextAttemptAt,
      publishedAt: r.publishedAt ?? undefined,
    });
  },
  toRecord(m: OutboxMessage, target: OutboxMessageRecord = new OutboxMessageRecord()): OutboxMessageRecord {
    target.id = m.id;
    target.aggregateId = m.aggregateId;
    target.eventType = m.eventType;
    target.payload = m.payload as Record<string, unknown>;
    target.occurredAt = m.occurredAt;
    target.attempts = m.attempts;
    target.nextAttemptAt = m.nextAttemptAt ?? m.occurredAt;
    target.publishedAt = m.publishedAt ?? null;
    if (target.lockedUntil === undefined) target.lockedUntil = null;
    if (target.lockedBy === undefined) target.lockedBy = null;
    if (target.lastError === undefined) target.lastError = null;
    return target;
  },
};
