import type { Clock } from '../../../shared/application/clock';
import type { IdGenerator } from '../../../shared/application/id-generator';
import type { AppLogger } from '../../../shared/application/logger';
import type { Metrics } from '../../../shared/application/metrics';
import type { UnitOfWork } from '../../../shared/application/unit-of-work';
import type { ReferenceRetryPolicy } from '../domain/reference-retry-policy';
import { SettlementService } from './settlement.service';

export interface PendingReferenceWorkerConfig {
  batchSize: number;
  /** transações reprocessadas em paralelo por ciclo (cada uma na sua transação SQL) */
  concurrency: number;
  pollIntervalMs: number;
}

export const DEFAULT_PENDING_WORKER_CONFIG: PendingReferenceWorkerConfig = { batchSize: 50, concurrency: 4, pollIntervalMs: 500 };

export type RetryResult = 'processed' | 'rejected' | 'rescheduled' | 'skipped';

/**
 * Worker agendado que reprocessa transações PENDING_REFERENCE vencidas.
 *
 * Cada transação: uma transação SQL própria →
 *   SELECT … FOR UPDATE SKIP LOCKED (a pendente) → lock da wallet → settle() → persistência
 * Mesma ordem de locks das outras entradas (linha da transação → wallet). Vários workers (várias
 * instâncias) dividem o trabalho sem coordenação: o SKIP LOCKED garante exclusividade.
 *
 * Política (domínio): backoff exponencial 500 ms → 60 s; 10 tentativas ou 15 min. Esgotado →
 * REJECTED / REFERENCE_NOT_FOUND + WagerTransactionRejected na outbox.
 */
export class PendingReferenceWorker {
  private running = false;
  private loop?: Promise<void>;
  private readonly settlement: SettlementService;

  constructor(
    private readonly uow: UnitOfWork,
    private readonly clock: Clock,
    ids: IdGenerator,
    private readonly metrics: Metrics,
    private readonly logger: AppLogger,
    retryPolicy: ReferenceRetryPolicy,
    private readonly config: PendingReferenceWorkerConfig = DEFAULT_PENDING_WORKER_CONFIG,
  ) {
    this.settlement = new SettlementService(ids, metrics, retryPolicy);
  }

  /** Um ciclo. Retorna quantas transações foram efetivamente reprocessadas (não puladas). */
  async runOnce(): Promise<number> {
    const now = this.clock.now();
    const ids = await this.uow.run((r) => r.wagerTransactions.findDuePendingReferenceIds(now, this.config.batchSize), {
      readOnly: true,
    });
    let handled = 0;
    for (let i = 0; i < ids.length; i += this.config.concurrency) {
      const results = await Promise.all(ids.slice(i, i + this.config.concurrency).map((id) => this.retry(id)));
      handled += results.filter((r) => r !== 'skipped').length;
    }
    return handled;
  }

  /** Reprocessa UMA pendente. Nunca lança: falhas ficam para o próximo ciclo. */
  async retry(id: string): Promise<RetryResult> {
    try {
      const result = await this.uow.run(async (repos): Promise<RetryResult> => {
        const now = this.clock.now();
        const tx = await repos.wagerTransactions.lockDuePendingReference(id, now);
        if (!tx) return 'skipped';
        const outcome = await this.settlement.settleAndPersist(repos, tx, {
          now,
          correlationId: `pending-retry:${tx.id}`,
          causationId: tx.id,
          emitPendingEvent: false,
        });
        if (outcome.type === 'pending_reference') return 'rescheduled';
        this.logger.info('pending transaction settled', {
          transactionId: tx.id,
          walletId: tx.walletId,
          providerId: tx.providerId,
          status: tx.status,
          failureCode: tx.failureCode,
          attempts: tx.attempts,
        });
        return outcome.type;
      });
      if (result !== 'skipped') this.metrics.increment('pending_reference_retries_total', { result });
      return result;
    } catch (err) {
      this.logger.error('pending transaction retry failed', { transactionId: id, error: err instanceof Error ? err.message : String(err) });
      return 'skipped';
    }
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.loop = (async () => {
      while (this.running) {
        let handled = 0;
        try {
          handled = await this.runOnce();
          const pending = await this.uow.run((r) => r.wagerTransactions.countPendingReference(), { readOnly: true });
          this.metrics.setGauge('pending_reference_transactions', pending);
        } catch (err) {
          this.logger.error('pending reference worker cycle failed', { error: err instanceof Error ? err.message : String(err) });
        }
        if (handled === 0 && this.running) await Bun.sleep(this.config.pollIntervalMs);
      }
    })();
  }

  async stop(): Promise<void> {
    this.running = false;
    await this.loop;
  }
}
