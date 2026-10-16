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
  | 'pending_reference_wakeups_total';

export type HistogramName = 'wager_processing_duration_seconds';

export interface Metrics {
  increment(name: CounterName, labels?: Record<string, string>, value?: number): void;
  observe(name: HistogramName, value: number, labels?: Record<string, string>): void;
}

export const METRICS = Symbol('METRICS');

export const noopMetrics: Metrics = { increment: () => {}, observe: () => {} };
