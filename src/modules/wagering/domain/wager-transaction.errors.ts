import { InvariantViolationError } from '../../../shared/domain/errors';
import type { WagerTransactionStatus } from './wager-transaction-status';

/** Tentativa de transição inválida — erro de programação, não caminho de negócio. */
export class InvalidTransactionStateError extends InvariantViolationError {
  constructor(
    readonly transactionId: string,
    readonly from: WagerTransactionStatus,
    readonly attempted: string,
  ) {
    super(`transaction ${transactionId}: cannot ${attempted} from status ${from}`);
  }
}
