import type { MikroORM } from '@mikro-orm/postgresql';
import { expect } from 'bun:test';
import type { HttpTestApp } from './http-app';
import { uuid } from './db';

export interface TestWallet {
  walletId: string;
  playerId: string;
}

export const brl = (amount: string) => ({ amount, currency: 'BRL' });

export async function createWallet(http: HttpTestApp, initial = '1000.00'): Promise<TestWallet> {
  const res = await http.post('/wallets', { playerId: uuid(), initialBalance: brl(initial) });
  if (res.status !== 201) throw new Error(`wallet creation failed: ${res.status} ${JSON.stringify(res.body)}`);
  return { walletId: res.body.id, playerId: res.body.playerId };
}

export interface WagerInput {
  kind: 'BET' | 'WIN' | 'LOSS' | 'REFUND' | 'ROLLBACK';
  amount: string;
  externalTransactionId?: string;
  referenceExternalTransactionId?: string;
  roundId?: string;
  providerId?: string;
  currency?: string;
  idempotencyKey?: string;
  playerId?: string;
  walletId?: string;
}

export function wagerBody(w: TestWallet, i: WagerInput) {
  const providerId = i.providerId ?? 'provider-a';
  const externalTransactionId = i.externalTransactionId ?? `tx-${uuid()}`;
  return {
    body: {
      providerId,
      externalTransactionId,
      playerId: i.playerId ?? w.playerId,
      walletId: i.walletId ?? w.walletId,
      roundId: i.roundId ?? 'round-1',
      gameId: 'fortune-chimp',
      kind: i.kind,
      money: { amount: i.amount, currency: i.currency ?? 'BRL' },
      ...(i.referenceExternalTransactionId ? { referenceExternalTransactionId: i.referenceExternalTransactionId } : {}),
    },
    idempotencyKey: i.idempotencyKey ?? `${providerId}:${externalTransactionId}`,
  };
}

export function submit(http: Pick<HttpTestApp, 'post'>, w: TestWallet, i: WagerInput) {
  const { body, idempotencyKey } = wagerBody(w, i);
  return http.post('/wagering/transactions', body, { 'idempotency-key': idempotencyKey });
}

/** Invariante final de TODOS os testes: wallet.balance == saldo reconstruído pelo ledger. */
export async function assertAllWalletsConsistent(orm: MikroORM): Promise<void> {
  const rows = await orm.em.getConnection().execute<{ id: string; stored: string; rebuilt: string; negative: boolean }[]>(
    `select w.id, w.balance_amount::text as stored,
            coalesce(sum(case e.direction when 'CREDIT' then e.amount else -e.amount end), 0)::numeric(20,2)::text as rebuilt,
            bool_or(e.balance_after < 0) as negative
       from wallets w left join wallet_ledger_entries e on e.wallet_id = w.id
      group by w.id, w.balance_amount`,
  );
  const broken = rows.filter((r) => r.stored !== r.rebuilt || r.negative);
  expect(broken).toEqual([]);
}
