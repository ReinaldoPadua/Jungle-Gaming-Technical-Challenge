import { ApplicationError, TransientError } from '../../../../shared/application/errors';
import type { Faults } from '../../../../shared/application/faults';
import type { AppLogger } from '../../../../shared/application/logger';
import type { Metrics } from '../../../../shared/application/metrics';
import { DomainError } from '../../../../shared/domain/errors';
import { classifyDbError } from '../../../../infrastructure/database/db-errors';
import type { QueueClient, QueueMessage } from '../../../messaging/application/queue';
import type { ProcessWagerTransactionUseCase } from '../../application/process-wager-transaction.use-case';
import { parseWagerMessage } from './wager-message';

export interface WagerConsumerConfig {
  consumerName: string;
  batchSize: number;
  waitSeconds: number;
  visibilityTimeoutSeconds: number;
  /** entregas máximas antes da DLQ (espelha o maxReceiveCount da redrive policy) */
  maxReceives: number;
  /** backoff de erro transitório: base · 2^(receiveCount-1), limitado a maxBackoff */
  retryBaseSeconds: number;
  retryMaxSeconds: number;
  shutdownGraceMs: number;
}

export type HandleOutcome = 'acked' | 'retry' | 'dead_lettered' | 'aborted';

type ErrorClass = { kind: 'permanent'; reason: string; detail: string } | { kind: 'transient'; detail: string };

/**
 * Consumidor de `wager-transactions.fifo`.
 *
 * Classificação de desfechos:
 *  - sucesso (PROCESSED / REJECTED / PENDING_REFERENCE / replay / duplicata) → ack após o COMMIT
 *  - permanente (envelope inválido, contrato violado, conflito de idempotência) → DLQ imediata
 *  - transitório (banco indisponível, lock, timeout, erro inesperado) → não faz ack; visibilidade com
 *    backoff; esgotadas `maxReceives` entregas → DLQ
 *
 * FIFO: mensagens do mesmo MessageGroupId (walletId) são tratadas em sequência; grupos distintos em
 * paralelo. Se uma mensagem do grupo falha, as seguintes do mesmo lote voltam para a fila sem serem
 * processadas (preserva a ordem).
 */
export class WagerConsumer {
  private running = false;
  private loop?: Promise<void>;
  private abort?: AbortController;
  private readonly inflight = new Set<Promise<unknown>>();
  /** mensagens recebidas e ainda não iniciadas — devolvidas no shutdown */
  private readonly notStarted = new Set<QueueMessage>();

  constructor(
    private readonly queue: QueueClient,
    private readonly useCase: ProcessWagerTransactionUseCase,
    private readonly metrics: Metrics,
    private readonly logger: AppLogger,
    private readonly faults: Faults,
    private readonly config: WagerConsumerConfig,
  ) {}

  // ------------------------------------------------------------------ ciclo

  /** Recebe um lote e trata. Retorna o número de mensagens recebidas. */
  async pollOnce(signal?: AbortSignal): Promise<number> {
    const messages = await this.queue.receive({
      maxMessages: this.config.batchSize,
      waitSeconds: this.config.waitSeconds,
      visibilityTimeoutSeconds: this.config.visibilityTimeoutSeconds,
      signal,
    });
    if (messages.length === 0) return 0;

    const groups = new Map<string, QueueMessage[]>();
    for (const m of messages) {
      const key = m.groupId ?? m.brokerMessageId;
      groups.set(key, [...(groups.get(key) ?? []), m]);
      this.notStarted.add(m);
    }
    const work = Promise.all([...groups.values()].map((group) => this.handleGroup(group)));
    this.inflight.add(work);
    try {
      await work;
    } finally {
      this.inflight.delete(work);
    }
    return messages.length;
  }

  private async handleGroup(group: QueueMessage[]): Promise<void> {
    for (let i = 0; i < group.length; i++) {
      const message = group[i]!;
      if (!this.running && this.loop) {
        // shutdown pedido: não começa mensagens novas
        await this.release(group.slice(i));
        return;
      }
      this.notStarted.delete(message);
      const outcome = await this.handle(message);
      if (outcome !== 'acked' && outcome !== 'dead_lettered') {
        // mantém a ordem do grupo: as seguintes voltam para a fila
        await this.release(group.slice(i + 1));
        return;
      }
    }
  }

  /** Trata UMA mensagem. Nunca lança (exceto crash simulado em teste). */
  async handle(message: QueueMessage): Promise<HandleOutcome> {
    this.metrics.setGauge('consumer_inflight_messages', this.inflight.size);
    const parsed = parseWagerMessage(message.body);
    if (!parsed.ok) return this.deadLetter(message, parsed.reason, parsed.detail);

    const { message: envelope, contentHash } = parsed;
    const log = {
      messageId: envelope.messageId,
      correlationId: envelope.messageId,
      providerId: envelope.data.providerId,
      walletId: envelope.data.walletId,
      receiveCount: message.receiveCount,
    };
    const heartbeat = this.startHeartbeat(message);
    try {
      const { result, outcome } = await this.useCase.executeDetailed(
        {
          ...envelope.data,
          correlationId: envelope.messageId,
          causationId: envelope.messageId,
          source: 'sqs',
        },
        { consumerName: this.config.consumerName, messageId: envelope.messageId, payloadHash: contentHash },
      );
      heartbeat.stop();
      // COMMIT já aconteceu. Se o processo morrer aqui, a mensagem volta e a inbox deduplica.
      this.faults.hit('consumer:after-commit-before-ack');
      await this.queue.ack(message);
      this.metrics.increment('consumer_messages_total', { outcome: outcome === 'duplicate_message' ? 'duplicate' : 'acked' });
      this.logger.info('wager message processed', { ...log, transactionId: result.transactionId, status: result.status, outcome });
      return 'acked';
    } catch (err) {
      heartbeat.stop();
      if (isSimulatedCrash(err)) throw err;
      const cls = classify(err);
      if (cls.kind === 'permanent') return this.deadLetter(message, cls.reason, cls.detail, log);
      return this.retryLater(message, cls.detail, log);
    }
  }

  private async retryLater(message: QueueMessage, detail: string, log: Record<string, unknown>): Promise<HandleOutcome> {
    if (message.receiveCount >= this.config.maxReceives) {
      return this.deadLetter(message, 'MAX_RECEIVES_EXCEEDED', detail, log);
    }
    const delay = Math.min(this.config.retryBaseSeconds * 2 ** (message.receiveCount - 1), this.config.retryMaxSeconds);
    try {
      await this.queue.changeVisibility(message, Math.round(delay));
    } catch (err) {
      // sem sucesso aqui a mensagem volta sozinha após o visibility timeout
      this.logger.warn('could not change message visibility', { ...log, error: errorMessage(err) });
    }
    this.metrics.increment('consumer_retries_total');
    this.metrics.increment('consumer_messages_total', { outcome: 'retried' });
    this.logger.warn('transient failure, message will be retried', { ...log, retryInSeconds: delay, error: detail });
    return 'retry';
  }

  private async deadLetter(message: QueueMessage, reason: string, detail: string, log: Record<string, unknown> = {}): Promise<HandleOutcome> {
    try {
      await this.queue.deadLetter({ message, reason, detail });
    } catch (err) {
      // DLQ indisponível: não faz ack — a redrive policy do SQS (maxReceiveCount) é a rede de segurança
      this.logger.error('could not dead-letter message', { ...log, reason, error: errorMessage(err) });
      return 'retry';
    }
    this.metrics.increment('dlq_messages_total', { reason });
    this.metrics.increment('consumer_messages_total', { outcome: 'dead_lettered' });
    this.logger.error('message sent to DLQ', { ...log, brokerMessageId: message.brokerMessageId, reason, detail });
    return 'dead_lettered';
  }

  private async release(messages: QueueMessage[]): Promise<void> {
    await Promise.allSettled(
      messages.map(async (m) => {
        this.notStarted.delete(m);
        await this.queue.changeVisibility(m, 0);
      }),
    );
  }

  /** Estende a visibilidade enquanto o processamento demora (evita entrega dupla concorrente). */
  private startHeartbeat(message: QueueMessage): { stop(): void } {
    const everyMs = Math.max(1_000, (this.config.visibilityTimeoutSeconds * 1_000) / 3);
    const timer = setInterval(() => {
      this.queue.changeVisibility(message, this.config.visibilityTimeoutSeconds).catch(() => {});
    }, everyMs);
    return { stop: () => clearInterval(timer) };
  }

  // -------------------------------------------------------------- lifecycle

  start(): void {
    if (this.running) return;
    this.running = true;
    this.abort = new AbortController();
    this.loop = (async () => {
      while (this.running) {
        try {
          await this.pollOnce(this.abort!.signal);
        } catch (err) {
          if (!this.running) break;
          this.logger.error('consumer poll failed', { error: errorMessage(err) });
          await Bun.sleep(1_000);
        }
      }
    })();
  }

  /**
   * SIGTERM: para de buscar mensagens (aborta o long-poll), conclui as que já
   * começaram (até shutdownGraceMs) e devolve à fila as recebidas e não iniciadas.
   */
  async stop(): Promise<void> {
    if (!this.running) return;
    this.running = false;
    this.abort?.abort();
    const grace = Bun.sleep(this.config.shutdownGraceMs).then(() => 'timeout' as const);
    const done = Promise.allSettled([...this.inflight]).then(() => 'done' as const);
    const result = await Promise.race([done, grace]);
    await this.release([...this.notStarted]);
    await this.loop?.catch(() => {});
    if (result === 'timeout') {
      // o que ainda está em andamento volta sozinho após o visibility timeout; a inbox deduplica
      this.logger.warn('consumer shutdown grace period exceeded', { inflight: this.inflight.size });
    }
  }
}

function classify(err: unknown): ErrorClass {
  if (err instanceof TransientError) return { kind: 'transient', detail: err.message };
  if (err instanceof ApplicationError) {
    // validation / conflict / not_found: reenviar a mesma mensagem nunca vai dar certo
    return { kind: 'permanent', reason: err.code, detail: err.message };
  }
  if (err instanceof DomainError) return { kind: 'permanent', reason: err.code, detail: err.message };
  if (classifyDbError(err) === 'transient') return { kind: 'transient', detail: errorMessage(err) };
  // erro inesperado (bug, violação de integridade): trata como transitório com limite de entregas →
  // DLQ depois de maxReceives, nunca ack silencioso
  return { kind: 'transient', detail: errorMessage(err) };
}

const errorMessage = (err: unknown) => (err instanceof Error ? err.message : String(err));

/** Erros de crash simulado (testes in-process) atravessam o consumidor sem tratamento. */
function isSimulatedCrash(err: unknown): boolean {
  return err instanceof Error && err.name === 'CrashError';
}
