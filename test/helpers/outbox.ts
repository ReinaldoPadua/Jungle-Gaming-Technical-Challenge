import type { MikroORM } from '@mikro-orm/postgresql';
import { appendFileSync } from 'node:fs';
import type { EventPublisher, PublishResult } from '../../src/modules/messaging/application/ports';
import type { OutboxMessage } from '../../src/modules/messaging/domain/outbox-message';
import { OutboxMessage as Outbox } from '../../src/modules/messaging/domain/outbox-message';
import { MikroOutboxRepository } from '../../src/modules/messaging/infrastructure/persistence/mikro-outbox.repository';
import { IntegrationEvent } from '../../src/shared/events/integration-event';
import type { FaultPoint, Faults } from '../../src/shared/application/faults';

export class TestEvent extends IntegrationEvent<{ seq: string }> {
  readonly eventType = 'TestEvent';
  readonly version = 1;
  static make(aggregateId: string, seq: number, occurredAt = new Date()): TestEvent {
    return new TestEvent({ eventId: Bun.randomUUIDv7(), aggregateId, correlationId: 'test', occurredAt, data: { seq: String(seq) } });
  }
}

/** Grava N mensagens na outbox numa transação confirmada. */
export async function seedOutbox(orm: MikroORM, n: number, opts: { aggregates?: number; occurredAt?: Date } = {}): Promise<string[]> {
  const aggregates = opts.aggregates ?? 1;
  // no passado (1 ms entre mensagens) para que todas já estejam vencidas
  const base = (opts.occurredAt ?? new Date()).getTime() - n;
  const messages = Array.from({ length: n }, (_, i) =>
    Outbox.enqueue(TestEvent.make(`agg-${i % aggregates}`, i, new Date(base + i))),
  );
  await orm.em.fork().transactional(async (em) => {
    await new MikroOutboxRepository(em).enqueue(...messages);
  });
  return messages.map((m) => m.id);
}

/** Publisher em memória com falhas programáveis. */
export class InMemoryPublisher implements EventPublisher {
  readonly published: { id: string; eventType: string; payload: unknown; publisher: string }[] = [];
  constructor(
    private readonly name = 'p',
    private readonly shouldFail: (m: OutboxMessage) => string | undefined = () => undefined,
    private readonly delayMs = 0,
  ) {}

  async publish(messages: OutboxMessage[]): Promise<PublishResult[]> {
    if (this.delayMs) await Bun.sleep(this.delayMs);
    return messages.map((m) => {
      const error = this.shouldFail(m);
      if (error) return { id: m.id, ok: false, error };
      this.published.push({ id: m.id, eventType: m.eventType, payload: m.payload, publisher: this.name });
      return { id: m.id, ok: true };
    });
  }
}

/** Publisher que anexa cada evento publicado a um arquivo (sobrevive ao processo). */
export class FilePublisher implements EventPublisher {
  constructor(private readonly path: string, private readonly name: string) {}
  async publish(messages: OutboxMessage[]): Promise<PublishResult[]> {
    for (const m of messages) appendFileSync(this.path, `${JSON.stringify({ id: m.id, publisher: this.name })}\n`);
    return messages.map((m) => ({ id: m.id, ok: true }));
  }
}

export class CrashError extends Error {}

/** Faults para testes in-process: em vez de matar o processo, lança CrashError. */
export const crashAt = (point: FaultPoint): Faults => ({
  hit(p) {
    if (p === point) throw new CrashError(`simulated crash at ${p}`);
  },
});
