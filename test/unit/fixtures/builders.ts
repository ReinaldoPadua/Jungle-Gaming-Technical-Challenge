import { Money } from '../../../src/shared/domain/money';
import { Wallet } from '../../../src/modules/wallet/domain/wallet';
import { WagerTransaction, type CreateWagerTransactionProps } from '../../../src/modules/wagering/domain/wager-transaction';
import { WagerTransactionKind } from '../../../src/modules/wagering/domain/wager-transaction-kind';
import type { ReferenceRetryPolicy } from '../../../src/modules/wagering/domain/reference-retry-policy';

export const T0 = new Date('2026-07-29T15:00:00.000Z');
export const at = (ms: number) => new Date(T0.getTime() + ms);

export const brl = (amount: string) => Money.from({ amount, currency: 'BRL' });
export const usd = (amount: string) => Money.from({ amount, currency: 'USD' });

let seq = 0;
export const nextId = (prefix = 'id') => `${prefix}-${++seq}`;

export const WALLET_ID = 'wallet-1';
export const PLAYER_ID = 'player-1';
export const PROVIDER_ID = 'provider-a';
export const ROUND_ID = 'round-987';

export function openWallet(initial = '100.00', currency = 'BRL'): Wallet {
  const money = Money.from({ amount: initial, currency });
  return Wallet.open({
    id: WALLET_ID,
    playerId: PLAYER_ID,
    initialBalance: money,
    openingTransactionId: nextId('opening'),
    openingEntryId: nextId('entry'),
    at: T0,
  }).wallet;
}

export function wager(
  kind: WagerTransactionKind,
  amount: string,
  overrides: Partial<CreateWagerTransactionProps> = {},
): WagerTransaction {
  const ext = overrides.externalTransactionId ?? nextId('ext');
  return WagerTransaction.create({
    id: nextId('tx'),
    providerId: PROVIDER_ID,
    externalTransactionId: ext,
    idempotencyKey: `${overrides.providerId ?? PROVIDER_ID}:${ext}`,
    payloadHash: 'hash',
    walletId: WALLET_ID,
    playerId: PLAYER_ID,
    roundId: ROUND_ID,
    gameId: 'fortune-chimp',
    kind,
    money: brl(amount),
    createdAt: T0,
    ...overrides,
  });
}

export const bet = (amount: string, o: Partial<CreateWagerTransactionProps> = {}) =>
  wager(WagerTransactionKind.Bet, amount, o);
export const win = (amount: string, o: Partial<CreateWagerTransactionProps> = {}) =>
  wager(WagerTransactionKind.Win, amount, o);
export const loss = (amount: string, o: Partial<CreateWagerTransactionProps> = {}) =>
  wager(WagerTransactionKind.Loss, amount, o);
export const refundOf = (ref: WagerTransaction, o: Partial<CreateWagerTransactionProps> = {}) =>
  wager(WagerTransactionKind.Refund, ref.money.amount, { referenceExternalTransactionId: ref.externalTransactionId, ...o });
export const rollbackOf = (ref: WagerTransaction, o: Partial<CreateWagerTransactionProps> = {}) =>
  wager(WagerTransactionKind.Rollback, ref.money.amount, { referenceExternalTransactionId: ref.externalTransactionId, ...o });

export const FAST_RETRY: ReferenceRetryPolicy = { maxAttempts: 3, baseDelayMs: 100, maxDelayMs: 1_000, ttlMs: 60_000 };
