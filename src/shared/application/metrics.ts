/** Contadores conhecidos. A lista cresce por fase; nomes estáveis (Prometheus). */
export type CounterName =
  | 'wallets_opened_total'
  | 'reconciliations_total'
  | 'reconciliation_mismatches_total'
  | 'db_transaction_retries_total'
  | 'db_lock_conflicts_total';

export interface Metrics {
  increment(name: CounterName, labels?: Record<string, string>, value?: number): void;
}

export const METRICS = Symbol('METRICS');

export const noopMetrics: Metrics = { increment: () => {} };
