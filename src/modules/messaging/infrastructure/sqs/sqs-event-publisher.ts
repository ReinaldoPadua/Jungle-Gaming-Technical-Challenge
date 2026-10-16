import { SendMessageBatchCommand, type SQSClient } from '@aws-sdk/client-sqs';
import type { EventPublisher, PublishResult } from '../../application/ports';
import type { OutboxMessage } from '../../domain/outbox-message';

const SQS_BATCH_LIMIT = 10;

/**
 * Publica envelopes na fila FIFO de eventos.
 *  - MessageDeduplicationId = eventId: republicações dentro da janela de 5 min do
 *    SQS são descartadas pelo broker (otimização; a garantia é o dedup do consumidor).
 *  - MessageGroupId = aggregateId (walletId): ordem por wallet dentro do broker.
 */
export class SqsEventPublisher implements EventPublisher {
  constructor(
    private readonly sqs: SQSClient,
    private readonly queueUrl: string,
  ) {}

  async publish(messages: OutboxMessage[]): Promise<PublishResult[]> {
    const results: PublishResult[] = [];
    for (let i = 0; i < messages.length; i += SQS_BATCH_LIMIT) {
      const chunk = messages.slice(i, i + SQS_BATCH_LIMIT);
      try {
        const out = await this.sqs.send(
          new SendMessageBatchCommand({
            QueueUrl: this.queueUrl,
            Entries: chunk.map((m, idx) => ({
              Id: String(idx),
              MessageBody: JSON.stringify(m.payload),
              MessageGroupId: m.aggregateId,
              MessageDeduplicationId: m.id,
              MessageAttributes: { eventType: { DataType: 'String', StringValue: m.eventType } },
            })),
          }),
        );
        const failed = new Map((out.Failed ?? []).map((f) => [f.Id, `${f.Code}: ${f.Message ?? ''}`]));
        chunk.forEach((m, idx) => {
          const error = failed.get(String(idx));
          results.push(error ? { id: m.id, ok: false, error } : { id: m.id, ok: true });
        });
      } catch (err) {
        const error = err instanceof Error ? err.message : String(err);
        for (const m of chunk) results.push({ id: m.id, ok: false, error });
      }
    }
    return results;
  }
}
