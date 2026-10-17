import {
  ChangeMessageVisibilityCommand,
  DeleteMessageCommand,
  ReceiveMessageCommand,
  SendMessageCommand,
  type SQSClient,
} from '@aws-sdk/client-sqs';
import type { DeadLetter, QueueClient, QueueMessage } from '../../application/queue';

export class SqsQueueClient implements QueueClient {
  constructor(
    private readonly sqs: SQSClient,
    private readonly queueUrl: string,
    private readonly dlqUrl: string,
  ) {}

  async receive(opts: { maxMessages: number; waitSeconds: number; visibilityTimeoutSeconds: number; signal?: AbortSignal }) {
    try {
      const out = await this.sqs.send(
        new ReceiveMessageCommand({
          QueueUrl: this.queueUrl,
          MaxNumberOfMessages: opts.maxMessages,
          WaitTimeSeconds: opts.waitSeconds,
          VisibilityTimeout: opts.visibilityTimeoutSeconds,
          MessageSystemAttributeNames: ['ApproximateReceiveCount', 'MessageGroupId'],
        }),
        { abortSignal: opts.signal },
      );
      return (out.Messages ?? []).map(
        (m): QueueMessage => ({
          brokerMessageId: m.MessageId!,
          receiptHandle: m.ReceiptHandle!,
          body: m.Body ?? '',
          groupId: m.Attributes?.MessageGroupId,
          receiveCount: Number(m.Attributes?.ApproximateReceiveCount ?? '1'),
        }),
      );
    } catch (err) {
      if (opts.signal?.aborted) return []; // shutdown durante o long-poll
      throw err;
    }
  }

  async ack(message: QueueMessage): Promise<void> {
    await this.sqs.send(new DeleteMessageCommand({ QueueUrl: this.queueUrl, ReceiptHandle: message.receiptHandle }));
  }

  async changeVisibility(message: QueueMessage, seconds: number): Promise<void> {
    await this.sqs.send(
      new ChangeMessageVisibilityCommand({ QueueUrl: this.queueUrl, ReceiptHandle: message.receiptHandle, VisibilityTimeout: seconds }),
    );
  }

  async deadLetter({ message, reason, detail }: DeadLetter): Promise<void> {
    // DLQ FIFO: mesmo grupo; dedup pelo id do broker (reenvio da DLQ após crash é descartado)
    await this.sqs.send(
      new SendMessageCommand({
        QueueUrl: this.dlqUrl,
        MessageBody: message.body,
        MessageGroupId: message.groupId ?? 'dead-letters',
        MessageDeduplicationId: message.brokerMessageId,
        MessageAttributes: {
          failureReason: { DataType: 'String', StringValue: reason },
          ...(detail ? { failureDetail: { DataType: 'String', StringValue: detail.slice(0, 1_000) } } : {}),
          originalReceiveCount: { DataType: 'Number', StringValue: String(message.receiveCount) },
        },
      }),
    );
    await this.ack(message);
  }
}
