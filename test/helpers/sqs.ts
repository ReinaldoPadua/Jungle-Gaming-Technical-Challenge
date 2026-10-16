import {
  DeleteMessageBatchCommand,
  GetQueueUrlCommand,
  PurgeQueueCommand,
  ReceiveMessageCommand,
  type Message,
  type SQSClient,
} from '@aws-sdk/client-sqs';

/** true se a LocalStack/SQS de teste está acessível (as suítes de SQS real dependem disso). */
export async function sqsAvailable(sqs: SQSClient, queueName: string): Promise<boolean> {
  try {
    await Promise.race([
      sqs.send(new GetQueueUrlCommand({ QueueName: queueName })),
      new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 1_500)),
    ]);
    return true;
  } catch {
    return false;
  }
}

export async function purge(sqs: SQSClient, QueueUrl: string): Promise<void> {
  await sqs.send(new PurgeQueueCommand({ QueueUrl }));
}

/** Recebe e apaga mensagens até `expected` ou até `idleMs` sem novidades. */
export async function drainQueue(sqs: SQSClient, QueueUrl: string, opts: { expected?: number; idleMs?: number } = {}) {
  const received: Message[] = [];
  let idleSince = Date.now();
  while (Date.now() - idleSince < (opts.idleMs ?? 2_000)) {
    const { Messages = [] } = await sqs.send(
      new ReceiveMessageCommand({ QueueUrl, MaxNumberOfMessages: 10, WaitTimeSeconds: 1, MessageSystemAttributeNames: ['All'], MessageAttributeNames: ['All'] }),
    );
    if (Messages.length > 0) {
      idleSince = Date.now();
      received.push(...Messages);
      await sqs.send(
        new DeleteMessageBatchCommand({ QueueUrl, Entries: Messages.map((m, i) => ({ Id: String(i), ReceiptHandle: m.ReceiptHandle! })) }),
      );
    }
    if (opts.expected !== undefined && received.length >= opts.expected) {
      // espera um pouco mais para detectar duplicatas indevidas
      if (Date.now() - idleSince > 500) break;
    }
  }
  return received;
}
