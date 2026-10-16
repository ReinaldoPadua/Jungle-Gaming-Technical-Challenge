import { InvariantViolationError } from '../../../shared/domain/errors';
import type { IntegrationEvent } from '../../../shared/events/integration-event';

export interface OutboxRetryPolicy {
  readonly baseDelayMs: number;
  readonly maxDelayMs: number;
}

/** 1s, 2s, 4s … até 5 min. A outbox nunca descarta: tentativas são ilimitadas e monitoradas por métrica. */
export const DEFAULT_OUTBOX_RETRY_POLICY: OutboxRetryPolicy = Object.freeze({ baseDelayMs: 1_000, maxDelayMs: 300_000 });

export interface OutboxMessageState {
  id: string;
  aggregateId: string;
  eventType: string;
  payload: Readonly<Record<string, unknown>>;
  occurredAt: Date;
  attempts: number;
  nextAttemptAt?: Date;
  publishedAt?: Date;
}

export class OutboxMessage {
  private constructor(
    public readonly id: string,
    public readonly aggregateId: string,
    public readonly eventType: string,
    public readonly payload: Readonly<Record<string, unknown>>,
    public readonly occurredAt: Date,
    private _attempts: number,
    private _nextAttemptAt?: Date,
    private _publishedAt?: Date,
  ) {}

  /** id da mensagem = eventId: consumidores deduplicam por ele. */
  static enqueue(event: IntegrationEvent<unknown>): OutboxMessage {
    const envelope = event.toJSON();
    return new OutboxMessage(
      envelope.eventId,
      envelope.aggregateId,
      envelope.eventType,
      Object.freeze(envelope as unknown as Record<string, unknown>),
      new Date(event.occurredAt.getTime()),
      0,
      new Date(event.occurredAt.getTime()),
    );
  }

  static rehydrate(s: OutboxMessageState): OutboxMessage {
    return new OutboxMessage(s.id, s.aggregateId, s.eventType, s.payload, s.occurredAt, s.attempts, s.nextAttemptAt, s.publishedAt);
  }

  get attempts(): number {
    return this._attempts;
  }
  get nextAttemptAt(): Date | undefined {
    return this._nextAttemptAt;
  }
  get publishedAt(): Date | undefined {
    return this._publishedAt;
  }

  isPending(): boolean {
    return this._publishedAt === undefined;
  }

  isDue(now: Date): boolean {
    return this.isPending() && (this._nextAttemptAt === undefined || this._nextAttemptAt.getTime() <= now.getTime());
  }

  markPublished(at: Date): void {
    if (!this.isPending()) throw new InvariantViolationError(`outbox message ${this.id} already published`);
    this._publishedAt = at;
    this._nextAttemptAt = undefined;
  }

  /** Incrementa attempts e agenda a próxima tentativa: base · 2^(attempts-1), limitado a maxDelay. */
  scheduleRetry(now: Date, policy: OutboxRetryPolicy = DEFAULT_OUTBOX_RETRY_POLICY): void {
    if (!this.isPending()) throw new InvariantViolationError(`outbox message ${this.id} already published`);
    this._attempts += 1;
    const delay = Math.min(policy.baseDelayMs * 2 ** (this._attempts - 1), policy.maxDelayMs);
    this._nextAttemptAt = new Date(now.getTime() + delay);
  }
}
