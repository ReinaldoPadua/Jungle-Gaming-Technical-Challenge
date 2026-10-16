import type { UnitOfWork } from '../../../shared/application/unit-of-work';
import { WagerTransactionNotFoundError } from './errors';
import { toWagerTransactionView, type WagerTransactionView } from './wager.views';

export class GetWagerTransactionQuery {
  constructor(private readonly uow: UnitOfWork) {}

  async byId(transactionId: string): Promise<WagerTransactionView> {
    const tx = await this.uow.run((r) => r.wagerTransactions.findById(transactionId), { readOnly: true });
    if (!tx) throw new WagerTransactionNotFoundError(transactionId);
    return toWagerTransactionView(tx);
  }

  async byProviderExternalId(providerId: string, externalTransactionId: string): Promise<WagerTransactionView> {
    const tx = await this.uow.run((r) => r.wagerTransactions.findByProviderExternalId(providerId, externalTransactionId), {
      readOnly: true,
    });
    if (!tx) throw new WagerTransactionNotFoundError(`${providerId}/${externalTransactionId}`);
    return toWagerTransactionView(tx);
  }
}
