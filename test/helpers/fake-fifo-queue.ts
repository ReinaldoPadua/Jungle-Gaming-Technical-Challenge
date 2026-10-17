import type { DeadLetter, QueueClient, QueueMessage } from '../../src/modules/messaging/application/queue';

interface Stored {
  brokerMessageId: string;
  body: string;
  groupId: string;
  receiveCount: number;
  invisibleUntil: number;
  receiptHandle?: string;
}

/**
 * Fila FIFO em memória com a semântica relevante do SQS FIFO:
 *  - visibility timeout e ChangeMessageVisibility
 *  - um grupo com mensagem em voo não entrega as seguintes (ordem por grupo)
 *  - receiptHandle muda a cada entrega (ack com handle antigo é ignorado)
 *  - redrive: mensagem com receiveCount >= maxReceiveCount vai para a DLQ no próximo receive
 */
export class FakeFifoQueue implements QueueClient {
  readonly messages: Stored[] = [];
  readonly dlq: (DeadLetter & { redrive?: boolean })[] = [];
  readonly acked: string[] = [];
  private seq = 0;

  constructor(private readonly maxReceiveCount = 5) {}

  send(body: unknown, groupId: string): string {
    const brokerMessageId = `bm-${++this.seq}`;
    this.messages.push({
      brokerMessageId,
      body: typeof body === 'string' ? body : JSON.stringify(body),
      groupId,
      receiveCount: 0,
      invisibleUntil: 0,
    });
    return brokerMessageId;
  }

  async receive(opts: { maxMessages: number; waitSeconds: number; visibilityTimeoutSeconds: number }): Promise<QueueMessage[]> {
    const now = Date.now();
    const busyGroups = new Set(this.messages.filter((m) => m.invisibleUntil > now).map((m) => m.groupId));
    const out: QueueMessage[] = [];
    for (const m of [...this.messages]) {
      if (out.length >= opts.maxMessages) break;
      if (m.invisibleUntil > now || busyGroups.has(m.groupId)) continue;
      if (m.receiveCount >= this.maxReceiveCount) {
        this.remove(m.brokerMessageId);
        this.dlq.push({ message: this.toQueueMessage(m), reason: 'REDRIVE_POLICY', redrive: true });
        continue;
      }
      m.receiveCount++;
      m.invisibleUntil = now + opts.visibilityTimeoutSeconds * 1_000;
      m.receiptHandle = `${m.brokerMessageId}#${m.receiveCount}`;
      out.push(this.toQueueMessage(m));
      // FIFO: as mensagens seguintes do mesmo grupo podem vir no MESMO lote, em ordem
    }
    if (out.length === 0 && opts.waitSeconds > 0) await Bun.sleep(Math.min(opts.waitSeconds * 1_000, 50));
    return out;
  }

  async ack(message: QueueMessage): Promise<void> {
    const m = this.find(message);
    if (!m) return; // handle expirado: o SQS também ignora/erra; aqui ignoramos
    this.remove(m.brokerMessageId);
    this.acked.push(m.brokerMessageId);
  }

  async changeVisibility(message: QueueMessage, seconds: number): Promise<void> {
    const m = this.find(message);
    if (m) m.invisibleUntil = Date.now() + seconds * 1_000;
  }

  async deadLetter(letter: DeadLetter): Promise<void> {
    this.dlq.push(letter);
    await this.ack(letter.message);
  }

  /** Simula o fim do visibility timeout de tudo que está em voo. */
  expireVisibility(): void {
    for (const m of this.messages) m.invisibleUntil = 0;
  }

  get pending(): number {
    return this.messages.length;
  }

  get inFlight(): number {
    const now = Date.now();
    return this.messages.filter((m) => m.invisibleUntil > now).length;
  }

  private find(message: QueueMessage): Stored | undefined {
    return this.messages.find((m) => m.receiptHandle === message.receiptHandle);
  }

  private remove(id: string): void {
    const i = this.messages.findIndex((m) => m.brokerMessageId === id);
    if (i >= 0) this.messages.splice(i, 1);
  }

  private toQueueMessage(m: Stored): QueueMessage {
    return { brokerMessageId: m.brokerMessageId, receiptHandle: m.receiptHandle ?? '', body: m.body, groupId: m.groupId, receiveCount: m.receiveCount };
  }
}
