import { Counter, Histogram, Registry, collectDefaultMetrics } from 'prom-client';
import type { CounterName, HistogramName, Metrics } from '../../shared/application/metrics';

/** Definição estática: o Prometheus exige o mesmo conjunto de labels por métrica. */
const COUNTERS: Record<CounterName, { help: string; labels: readonly string[] }> = {
  wallets_opened_total: { help: 'Wallets created', labels: ['currency'] },
  reconciliations_total: { help: 'Wallet reconciliations executed, by result', labels: ['result'] },
  reconciliation_mismatches_total: { help: 'Reconciliations that found stored balance != ledger', labels: [] },
  db_transaction_retries_total: { help: 'Database transactions retried after a transient error', labels: [] },
  db_lock_conflicts_total: { help: 'Lock timeouts and deadlocks observed', labels: ['sqlstate'] },
  wager_transactions_total: { help: 'Wager transactions decided, by kind/status/source', labels: ['kind', 'status', 'source'] },
  idempotent_replays_total: { help: 'Requests answered from a previously stored result', labels: ['source'] },
  idempotency_conflicts_total: { help: 'Same idempotency key or external id with a different payload', labels: ['reason'] },
  pending_reference_wakeups_total: { help: 'Pending transactions woken up by the arrival of their reference', labels: [] },
};

const HISTOGRAMS: Record<HistogramName, { help: string; labels: readonly string[]; buckets: number[] }> = {
  wager_processing_duration_seconds: {
    help: 'End-to-end processing latency of a wager transaction (use case)',
    labels: ['kind', 'outcome', 'source'],
    buckets: [0.002, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5],
  },
};

export class PromMetrics implements Metrics {
  readonly registry = new Registry();
  private readonly counters: Record<CounterName, Counter>;
  private readonly histograms: Record<HistogramName, Histogram>;

  constructor(opts: { defaultMetrics?: boolean; instanceId?: string } = {}) {
    if (opts.instanceId) this.registry.setDefaultLabels({ instance_id: opts.instanceId });
    if (opts.defaultMetrics) collectDefaultMetrics({ register: this.registry });
    this.counters = Object.fromEntries(
      Object.entries(COUNTERS).map(([name, def]) => [
        name,
        new Counter({ name, help: def.help, labelNames: [...def.labels], registers: [this.registry] }),
      ]),
    ) as Record<CounterName, Counter>;
    this.histograms = Object.fromEntries(
      Object.entries(HISTOGRAMS).map(([name, def]) => [
        name,
        new Histogram({ name, help: def.help, labelNames: [...def.labels], buckets: def.buckets, registers: [this.registry] }),
      ]),
    ) as Record<HistogramName, Histogram>;
  }

  observe(name: HistogramName, value: number, labels: Record<string, string> = {}): void {
    this.histograms[name].observe(labels, value);
  }

  increment(name: CounterName, labels: Record<string, string> = {}, value = 1): void {
    this.counters[name].inc(labels, value);
  }

  /** Valor atual de um contador (soma de todas as séries) — usado em testes e diagnósticos. */
  async value(name: CounterName): Promise<number> {
    const m = await this.counters[name].get();
    return m.values.reduce((acc, v) => acc + v.value, 0);
  }

  metrics(): Promise<string> {
    return this.registry.metrics();
  }

  get contentType(): string {
    return this.registry.contentType;
  }
}
