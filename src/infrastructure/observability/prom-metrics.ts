import { Counter, Registry, collectDefaultMetrics } from 'prom-client';
import type { CounterName, Metrics } from '../../shared/application/metrics';

/** Definição estática: o Prometheus exige o mesmo conjunto de labels por métrica. */
const COUNTERS: Record<CounterName, { help: string; labels: readonly string[] }> = {
  wallets_opened_total: { help: 'Wallets created', labels: ['currency'] },
  reconciliations_total: { help: 'Wallet reconciliations executed, by result', labels: ['result'] },
  reconciliation_mismatches_total: { help: 'Reconciliations that found stored balance != ledger', labels: [] },
  db_transaction_retries_total: { help: 'Database transactions retried after a transient error', labels: [] },
  db_lock_conflicts_total: { help: 'Lock timeouts and deadlocks observed', labels: ['sqlstate'] },
};

export class PromMetrics implements Metrics {
  readonly registry = new Registry();
  private readonly counters: Record<CounterName, Counter>;

  constructor(opts: { defaultMetrics?: boolean; instanceId?: string } = {}) {
    if (opts.instanceId) this.registry.setDefaultLabels({ instance_id: opts.instanceId });
    if (opts.defaultMetrics) collectDefaultMetrics({ register: this.registry });
    this.counters = Object.fromEntries(
      Object.entries(COUNTERS).map(([name, def]) => [
        name,
        new Counter({ name, help: def.help, labelNames: [...def.labels], registers: [this.registry] }),
      ]),
    ) as Record<CounterName, Counter>;
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
