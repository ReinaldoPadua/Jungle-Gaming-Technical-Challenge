import type { MikroORM } from '@mikro-orm/postgresql';
import type { ClaimedOutboxMessage, OutboxStore } from '../../application/ports';
import { OutboxMessage } from '../../domain/outbox-message';

interface OutboxRow {
  id: string;
  aggregate_id: string;
  event_type: string;
  payload: Record<string, unknown>;
  occurred_at: string | Date;
  attempts: number;
  next_attempt_at: string | Date;
  locked_until: string | Date;
  published_at: string | Date | null;
}

const date = (v: string | Date) => (v instanceof Date ? v : new Date(v));

/** Comandos autocontidos (autocommit) — sem transação aberta durante o I/O com o broker. */
export class MikroOutboxStore implements OutboxStore {
  constructor(private readonly orm: MikroORM) {}

  private get conn() {
    return this.orm.em.getConnection();
  }

  async claim({ owner, limit, leaseMs, now }: { owner: string; limit: number; leaseMs: number; now: Date }) {
    const rows = await this.conn.execute<OutboxRow[]>(
      `update outbox_messages o
          set locked_until = ?::timestamptz + make_interval(secs => ? / 1000.0), locked_by = ?
        where o.id in (
          select id from outbox_messages
           where published_at is null
             and next_attempt_at <= ?
             and (locked_until is null or locked_until < ?)
           order by occurred_at
           limit ?
           for update skip locked)
       returning o.*`,
      [now, leaseMs, owner, now, now, limit],
    );
    return rows
      .map(
        (r): ClaimedOutboxMessage => ({
          message: OutboxMessage.rehydrate({
            id: r.id,
            aggregateId: r.aggregate_id,
            eventType: r.event_type,
            payload: r.payload,
            occurredAt: date(r.occurred_at),
            attempts: r.attempts,
            nextAttemptAt: date(r.next_attempt_at),
            publishedAt: r.published_at ? date(r.published_at) : undefined,
          }),
          lockedUntil: date(r.locked_until),
        }),
      )
      .sort((a, b) => a.message.occurredAt.getTime() - b.message.occurredAt.getTime());
  }

  async markPublished(ids: string[], now: Date): Promise<number> {
    if (ids.length === 0) return 0;
    // `published_at is null`: se outra instância (lease expirado) já marcou, não toca —
    // o trigger outbox_guard proíbe alterar uma publicação já registrada.
    const rows = await this.conn.execute<{ id: string }[]>(
      `update outbox_messages set published_at = ?, locked_until = null, locked_by = null, last_error = null
        where id in (?) and published_at is null
       returning id`,
      [now, ids],
    );
    return rows.length;
  }

  async reschedule(message: OutboxMessage, error: string): Promise<void> {
    await this.conn.execute(
      `update outbox_messages
          set attempts = ?, next_attempt_at = ?, last_error = ?, locked_until = null, locked_by = null
        where id = ? and published_at is null`,
      [message.attempts, message.nextAttemptAt, error, message.id],
    );
  }

  async stats(now: Date) {
    const [row] = await this.conn.execute<{ pending: string; oldest: string | null }[]>(
      `select count(*)::text as pending,
              extract(epoch from (?::timestamptz - min(occurred_at)))::text as oldest
         from outbox_messages where published_at is null`,
      [now],
    );
    return { pending: Number(row!.pending), oldestAgeSeconds: row!.oldest === null ? 0 : Math.max(0, Number(row!.oldest)) };
  }
}
