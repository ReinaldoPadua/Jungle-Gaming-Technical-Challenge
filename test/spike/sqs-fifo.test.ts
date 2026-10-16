/**
 * Spike 3 — SQS FIFO na LocalStack com o AWS SDK v3 sob Bun:
 *  - deduplicação por MessageDeduplicationId
 *  - ChangeMessageVisibility(0) devolve a mensagem (usado no SIGTERM)
 *  - redrive para DLQ após maxReceiveCount
 * Usa filas efêmeras com nome único para não interferir em nada.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import {
  ChangeMessageVisibilityCommand,
  CreateQueueCommand,
  DeleteMessageCommand,
  DeleteQueueCommand,
  GetQueueAttributesCommand,
  ReceiveMessageCommand,
  SendMessageCommand,
  type SQSClient,
} from '@aws-sdk/client-sqs';
import { sqsClient, uniqueSuffix } from '../helpers/infra';

let sqs: SQSClient;
let mainUrl: string;
let dlqUrl: string;

const receive = async (QueueUrl: string, WaitTimeSeconds = 2) =>
  (await sqs.send(
    new ReceiveMessageCommand({
      QueueUrl,
      MaxNumberOfMessages: 10,
      WaitTimeSeconds,
      MessageSystemAttributeNames: ['ApproximateReceiveCount'],
    }),
  )).Messages ?? [];

beforeAll(async () => {
  sqs = sqsClient();
  const id = uniqueSuffix();
  const dlq = await sqs.send(
    new CreateQueueCommand({ QueueName: `spike-dlq-${id}.fifo`, Attributes: { FifoQueue: 'true' } }),
  );
  dlqUrl = dlq.QueueUrl!;
  const dlqArn = (
    await sqs.send(new GetQueueAttributesCommand({ QueueUrl: dlqUrl, AttributeNames: ['QueueArn'] }))
  ).Attributes!.QueueArn!;
  const main = await sqs.send(
    new CreateQueueCommand({
      QueueName: `spike-${id}.fifo`,
      Attributes: {
        FifoQueue: 'true',
        VisibilityTimeout: '1',
        RedrivePolicy: JSON.stringify({ deadLetterTargetArn: dlqArn, maxReceiveCount: '1' }),
      },
    }),
  );
  mainUrl = main.QueueUrl!;
});

afterAll(async () => {
  await Promise.allSettled([mainUrl, dlqUrl].filter(Boolean).map((QueueUrl) => sqs.send(new DeleteQueueCommand({ QueueUrl }))));
  sqs?.destroy();
});

const send = (body: string, dedupId: string, group = 'wallet-1') =>
  sqs.send(
    new SendMessageCommand({ QueueUrl: mainUrl, MessageBody: body, MessageGroupId: group, MessageDeduplicationId: dedupId }),
  );

describe('spike: SQS FIFO on LocalStack', () => {
  test('deduplicates by MessageDeduplicationId and preserves group order', async () => {
    await send('a', 'dedup-a');
    await send('a', 'dedup-a'); // duplicata do produtor
    await send('b', 'dedup-b');

    const got: string[] = [];
    for (let i = 0; i < 5 && got.length < 2; i++) {
      for (const m of await receive(mainUrl, 1)) {
        got.push(m.Body!);
        await sqs.send(new DeleteMessageCommand({ QueueUrl: mainUrl, ReceiptHandle: m.ReceiptHandle! }));
      }
    }
    expect(got).toEqual(['a', 'b']);
  });

  test('ChangeMessageVisibility(0) makes an in-flight message immediately available', async () => {
    await send('c', 'dedup-c', 'wallet-2');
    const [first] = await receive(mainUrl);
    expect(first?.Body).toBe('c');
    await sqs.send(
      new ChangeMessageVisibilityCommand({ QueueUrl: mainUrl, ReceiptHandle: first!.ReceiptHandle!, VisibilityTimeout: 0 }),
    );
    // maxReceiveCount=1: a próxima tentativa de receive move a mensagem para a DLQ
    await receive(mainUrl, 1);
    const inDlq = await receive(dlqUrl);
    expect(inDlq.map((m) => m.Body)).toContain('c');
  });
});
