import type { Clock } from '../../../shared/application/clock';
import type { Faults } from '../../../shared/application/faults';
import type { AppLogger } from '../../../shared/application/logger';
import type { Metrics } from '../../../shared/application/metrics';
import { DEFAULT_OUTBOX_RETRY_POLICY, type OutboxRetryPolicy } from '../domain/outbox-message';
import type { EventPublisher, OutboxStore } from './ports';

export interface OutboxPublisherConfig {
  /** identificação deste publisher no lease (instância) */
  owner: string;
  batchSize: number;
  leaseMs: number;
  pollIntervalMs: number;
  statsIntervalMs: number;
  retryPolicy: OutboxRetryPolicy;
}

export const DEFAULT_OUTBOX_PUBLISHER_CONFIG: Omit<OutboxPublisherConfig, 'owner'> = {
  batchSize: 50,
  leaseMs: 30_000,
  pollIntervalMs: 200,
  statsIntervalMs: 5_000,
  retryPolicy: DEFAULT_OUTBOX_RETRY_POLICY,
};

/**
 * Publica eventos confirmados da outbox. Garantia: at-least-once.
 *
 *   claim (lease + SKIP LOCKED) → publish → markPublished
 *
 * - Commit da transação financeira acontece ANTES (no use case); aqui só se lê
 *   o que já foi confirmado — nunca se publica antes do commit.
 * - Processo morre depois de publicar e antes de marcar → o lease expira, outra
 *   instância republica. O id da mensagem é o eventId (MessageDeduplicationId no
 *   SQS FIFO e chave de dedup dos consumidores), então a duplicata é inofensiva.
 * - Falha de publicação → backoff exponencial calculado pelo domínio; nunca descarta.
 */
export class OutboxPublisher {
  private running = false;
  private loop?: Promise<void>;
  private lastStatsAt = 0;

  constructor(
    private readonly store: OutboxStore,
    private readonly publisher: EventPublisher,
    private readonly clock: Clock,
    private readonly metrics: Metrics,
    private readonly logger: AppLogger,
    private readonly faults: Faults,
    private readonly config: OutboxPublisherConfig,
  ) {}

  /** Um ciclo: reserva, publica e registra o desfecho. Retorna quantas mensagens tratou. */
  async runOnce(): Promise<number> {
    const now = this.clock.now();
    const claimed = await this.store.claim({
      owner: this.config.owner,
      limit: this.config.batchSize,
      leaseMs: this.config.leaseMs,
      now,
    });
    if (claimed.length === 0) return 0;
    this.metrics.increment('outbox_claimed_total', {}, claimed.length);

    const messages = claimed.map((c) => c.message);
    let results;
    try {
      results = await this.publisher.publish(messages);
    } catch (err) {
      // broker indisponível: tudo falhou neste ciclo
      const error = err instanceof Error ? err.message : String(err);
      results = messages.map((m) => ({ id: m.id, ok: false, error }));
    }

    this.faults.hit('outbox:after-publish');

    const byId = new Map(messages.map((m) => [m.id, m]));
    const published = results.filter((r) => r.ok).map((r) => r.id);
    if (published.length > 0) {
      await this.store.markPublished(published, this.clock.now());
      for (const id of published) this.metrics.increment('outbox_published_total', { event_type: byId.get(id)!.eventType });
    }
    for (const failure of results.filter((r) => !r.ok)) {
      const message = byId.get(failure.id)!;
      message.scheduleRetry(this.clock.now(), this.config.retryPolicy);
      await this.store.reschedule(message, (failure.error ?? 'unknown error').slice(0, 1_000));
      this.metrics.increment('outbox_publish_failures_total');
      this.logger.warn('outbox publish failed, rescheduled', {
        outboxMessageId: message.id,
        eventType: message.eventType,
        attempts: message.attempts,
        nextAttemptAt: message.nextAttemptAt?.toISOString(),
        error: failure.error,
      });
    }
    return claimed.length;
  }

  /** Loop até `stop()`: ciclos seguidos enquanto houver trabalho; senão espera pollInterval. */
  start(): void {
    if (this.running) return;
    this.running = true;
    this.loop = (async () => {
      while (this.running) {
        let handled = 0;
        try {
          handled = await this.runOnce();
          await this.refreshStats();
        } catch (err) {
          this.logger.error('outbox publisher cycle failed', { error: err instanceof Error ? err.message : String(err) });
        }
        if (handled === 0 && this.running) await Bun.sleep(this.config.pollIntervalMs);
      }
    })();
  }

  /** Para de reservar novas mensagens e espera o ciclo em andamento terminar. */
  async stop(): Promise<void> {
    this.running = false;
    await this.loop;
  }

  async refreshStats(force = false): Promise<void> {
    const nowMs = this.clock.now().getTime();
    if (!force && nowMs - this.lastStatsAt < this.config.statsIntervalMs) return;
    this.lastStatsAt = nowMs;
    const stats = await this.store.stats(this.clock.now());
    this.metrics.setGauge('outbox_pending_messages', stats.pending);
    this.metrics.setGauge('outbox_lag_seconds', stats.oldestAgeSeconds);
  }
}
