import { ConflictError, NotFoundError } from '../../../shared/application/errors';

export class WalletAlreadyExistsError extends ConflictError {
  constructor(playerId: string, currency: string) {
    super('WALLET_ALREADY_EXISTS', `player ${playerId} already has a ${currency} wallet`, { playerId, currency });
  }
}

export class WalletNotFoundError extends NotFoundError {
  constructor(walletId: string) {
    super('WALLET_NOT_FOUND', `wallet ${walletId} not found`);
  }
}
