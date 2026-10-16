import { describe, expect, test } from 'bun:test';
import { InvariantViolationError } from '../../src/shared/domain/errors';
import { InboxMessage } from '../../src/modules/messaging/domain/inbox-message';
import { OutboxMessage } from '../../src/modules/messaging/domain/outbox-message';
import { WagerTransactionProcessed } from '../../src/modules/wagering/domain/events';
import { at, bet, brl, T0 } from './fixtures/builders';

describe('InboxMessage', () => {
  test('receive → markProcessed uma única vez', () => {
    const m = InboxMessage.receive({ messageId: 'msg-1', consumerName: 'wager-consumer', payloadHash: 'h', receivedAt: T0 });
    expect(m.isProcessed()).toBe(false);
    m.markProcessed(at(1));
    expect(m.isProcessed()).toBe(true);
    expect(() => m.markProcessed(at(2))).toThrow(InvariantViolationError);
  });
});

describe('OutboxMessage', () => {
  const event = () => {
    const tx = bet('10.00');
    tx.markProcessed(undefined, T0, brl('90.00'));
    return WagerTransactionProcessed.from(tx, { eventId: 'evt-1', correlationId: 'c', occurredAt: T0 });
  };

  test('enqueue usa eventId como id e grava o envelope serializado', () => {
    const m = OutboxMessage.enqueue(event());
    expect(m.id).toBe('evt-1');
    expect(m.eventType).toBe('WagerTransactionProcessed');
    expect(m.payload.eventId).toBe('evt-1');
    expect(m.attempts).toBe(0);
    expect(m.isPending()).toBe(true);
    expect(m.isDue(T0)).toBe(true);
  });

  test('scheduleRetry aplica backoff exponencial limitado', () => {
    const m = OutboxMessage.enqueue(event());
    const policy = { baseDelayMs: 1_000, maxDelayMs: 5_000 };
    m.scheduleRetry(T0, policy);
    expect(m.attempts).toBe(1);
    expect(m.nextAttemptAt).toEqual(at(1_000));
    expect(m.isDue(at(999))).toBe(false);
    expect(m.isDue(at(1_000))).toBe(true);
    m.scheduleRetry(T0, policy);
    m.scheduleRetry(T0, policy);
    m.scheduleRetry(T0, policy);
    expect(m.nextAttemptAt).toEqual(at(5_000));
  });

  test('markPublished é final', () => {
    const m = OutboxMessage.enqueue(event());
    m.markPublished(at(1));
    expect(m.isPending()).toBe(false);
    expect(m.isDue(at(10))).toBe(false);
    expect(() => m.markPublished(at(2))).toThrow(InvariantViolationError);
    expect(() => m.scheduleRetry(at(2))).toThrow(InvariantViolationError);
  });
});
