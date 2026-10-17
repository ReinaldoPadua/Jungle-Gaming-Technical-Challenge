import type { Clock } from '../../../shared/application/clock';
import type { AppLogger } from '../../../shared/application/logger';
import type { Metrics } from '../../../shared/application/metrics';
import type { UnitOfWork } from '../../../shared/application/unit-of-work';
import type { MoneyProps } from '../../../shared/domain/money';
import { WalletNotFoundError } from './errors';

export interface ReconciliationReport {
  walletId: string;
  storedBalance: MoneyProps;
  calculatedBalance: MoneyProps;
  /** stored − calculated */
  difference: MoneyProps;
  consistent: boolean;
  checkedEntries: number;
  /** detalhes adicionais do diagnóstico */
  chainBreaks: number;
  lastEntryMatchesStored: boolean;
  checkedAt: string;
}

/**
 * Compara o saldo materializado com o saldo reconstruído pelo ledger.
 * Lê wallet e ledger no MESMO snapshot (REPEATABLE READ, read-only): o
 * resultado não é afetado por escritas concorrentes e não bloqueia ninguém.
 * Divergências NUNCA são corrigidas: são logadas, contabilizadas e sinalizadas.
 */
export class ReconcileWalletUseCase {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly clock: Clock,
    private readonly metrics: Metrics,
    private readonly logger: AppLogger,
  ) {}

  async execute(walletId: string, ctx: { correlationId: string }): Promise<ReconciliationReport> {
    const result = await this.uow.run(
      async (r) => {
        const wallet = await r.wallets.findById(walletId);
        if (!wallet) return undefined;
        return { wallet, summary: await r.ledger.summarize(walletId, wallet.currency) };
      },
      { isolation: 'repeatable read', readOnly: true },
    );
    if (!result) throw new WalletNotFoundError(walletId);

    const { wallet, summary } = result;
    const stored = wallet.balance;
    const difference = stored.subtract(summary.calculatedBalance);
    const lastEntryMatchesStored =
      summary.lastBalanceAfter === undefined ? stored.isZero() : summary.lastBalanceAfter.equals(stored);
    const consistent = difference.isZero() && summary.chainBreaks === 0 && lastEntryMatchesStored;

    const report: ReconciliationReport = {
      walletId,
      storedBalance: stored.toJSON(),
      calculatedBalance: summary.calculatedBalance.toJSON(),
      difference: difference.toJSON(),
      consistent,
      checkedEntries: summary.entries,
      chainBreaks: summary.chainBreaks,
      lastEntryMatchesStored,
      checkedAt: this.clock.now().toISOString(),
    };

    this.metrics.increment('reconciliations_total', { result: consistent ? 'consistent' : 'mismatch' });
    if (!consistent) {
      this.metrics.increment('reconciliation_mismatches_total');
      // sem valores no log (política de dados): o relatório completo está na resposta
      this.logger.error('wallet reconciliation mismatch', {
        walletId,
        differenceSign: difference.isNegative() ? 'negative' : 'positive',
        chainBreaks: summary.chainBreaks,
        checkedEntries: summary.entries,
        lastEntryMatchesStored,
      });
    }
    return report;
  }
}

