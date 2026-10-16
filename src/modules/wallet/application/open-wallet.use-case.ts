import type { Clock } from '../../../shared/application/clock';
import type { IdGenerator } from '../../../shared/application/id-generator';
import type { Metrics } from '../../../shared/application/metrics';
import type { UnitOfWork } from '../../../shared/application/unit-of-work';
import { Money, type MoneyProps } from '../../../shared/domain/money';
import { OutboxMessage } from '../../messaging/domain/outbox-message';
import { WalletBalanceChanged } from '../../wagering/domain/events';
import { WagerTransaction } from '../../wagering/domain/wager-transaction';
import { Wallet } from '../domain/wallet';
import { toWalletView, type WalletView } from './wallet.views';

export interface OpenWalletCommand {
  playerId: string;
  initialBalance: MoneyProps;
  correlationId: string;
}

/**
 * Cria a wallet. Saldo inicial > 0 gera, na MESMA transação SQL:
 * transação interna OPENING (PROCESSED) + lançamento CREDIT + evento
 * WalletBalanceChanged na outbox. Duplicidade (player, moeda) é barrada pela
 * constraint única — seguro contra corrida entre instâncias.
 */
export class OpenWalletUseCase {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly clock: Clock,
    private readonly ids: IdGenerator,
    private readonly metrics: Metrics,
  ) {}

  async execute(cmd: OpenWalletCommand): Promise<WalletView> {
    const initialBalance = Money.from(cmd.initialBalance);
    const now = this.clock.now();
    const walletId = this.ids.next();
    const opening = initialBalance.isPositive()
      ? WagerTransaction.createOpening({ id: this.ids.next(), walletId, playerId: cmd.playerId, money: initialBalance, at: now })
      : undefined;

    const { wallet, openingEntry } = Wallet.open({
      id: walletId,
      playerId: cmd.playerId,
      initialBalance,
      openingTransactionId: opening?.id,
      openingEntryId: opening ? this.ids.next() : undefined,
      at: now,
    });

    await this.uow.run(async (repos) => {
      // ordem: transação → wallet → ledger (FKs compostas do ledger)
      if (opening) await repos.wagerTransactions.insert(opening, { correlationId: cmd.correlationId });
      await repos.wallets.insert(wallet);
      if (openingEntry) {
        await repos.ledger.append(openingEntry);
        await repos.outbox.enqueue(
          OutboxMessage.enqueue(
            WalletBalanceChanged.from(wallet, openingEntry, {
              eventId: this.ids.next(),
              correlationId: cmd.correlationId,
              occurredAt: now,
            }),
          ),
        );
      }
    });

    this.metrics.increment('wallets_opened_total', { currency: wallet.currency });
    return toWalletView(wallet);
  }
}
