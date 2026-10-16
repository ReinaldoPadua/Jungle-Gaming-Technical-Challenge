import { DomainError } from '../../../shared/domain/errors';
import type { Money } from '../../../shared/domain/money';

export class InsufficientFundsError extends DomainError {
  readonly code = 'INSUFFICIENT_FUNDS';
  constructor(
    readonly walletId: string,
    readonly balance: Money,
    readonly requested: Money,
  ) {
    super(`wallet ${walletId} has insufficient funds: balance ${balance}, requested ${requested}`);
  }
}
