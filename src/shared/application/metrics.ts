/** Contadores conhecidos. A lista cresce por fase; nomes estáveis (Prometheus). */
export type CounterName =
  | 'wallets_opened_total'
  | 'reconciliations_total'
  | 'reconciliation_mismatches_total'
  | 'db_transaction_retries_total'
  | 'db_lock_conflicts_total'
  | 'wager_transactions_total'
  | 'idempotent_replays_total'
  | 'idempotency_conflicts_total'
  | 'pending_reference_wakeups_total'
  | 'outbox_claimed_total'
  | 'outbox_published_total'
  | 'outbox_publish_failures_total'
  | 'inbox_duplicates_total'
  | 'consumer_messages_total'
  | 'dlq_messages_total'
  | 'consumer_retries_total';

export type GaugeName = 'outbox_lag_seconds' | 'outbox_pending_messages' | 'consumer_inflight_messages';

export type HistogramName = 'wager_processing_duration_seconds';

export interface Metrics {
  increment(name: CounterName, labels?: Record<string, string>, value?: number): void;
  observe(name: HistogramName, value: number, labels?: Record<string, string>): void;
  setGauge(name: GaugeName, value: number): void;
}

export const METRICS = Symbol('METRICS');

export const noopMetrics: Metrics = { increment: () => {}, observe: () => {}, setGauge: () => {} };
