import { expect } from 'bun:test';
import type { EntityManager, MikroORM } from '@mikro-orm/postgresql';

export const uuid = () => crypto.randomUUID();
export const hash = () => new Bun.CryptoHasher('sha256').update(uuid()).digest('hex');

/** Migra para o estado mais recente a partir de um banco limpo. */
export async function migrateFresh(orm: MikroORM): Promise<void> {
  const migrator = orm.getMigrator();
  await migrator.down({ to: 0 });
  await migrator.up();
}

/** TRUNCATE não dispara triggers de linha — uso exclusivo da suíte de testes. */
export async function truncateAll(orm: MikroORM): Promise<void> {
  await orm.em
    .getConnection()
    .execute('truncate outbox_messages, inbox_messages, wallet_ledger_entries, wager_transactions, wallets');
}

interface PgError {
  code?: string;
  constraint?: string;
  message: string;
}

/** Espera que a operação falhe com o SQLSTATE indicado (e, opcionalmente, a constraint). */
export async function expectSqlState(op: Promise<unknown>, code: string, constraintOrMessage?: string | RegExp) {
  let error: PgError | undefined;
  try {
    await op;
  } catch (e) {
    error = e as PgError;
  }
  expect(error, 'expected the operation to fail').toBeDefined();
  expect(error!.code, error!.message).toBe(code);
  if (typeof constraintOrMessage === 'string') expect(error!.constraint ?? error!.message).toContain(constraintOrMessage);
  if (constraintOrMessage instanceof RegExp) expect(error!.message).toMatch(constraintOrMessage);
}

export const SQLSTATE = {
  uniqueViolation: '23505',
  checkViolation: '23514',
  foreignKeyViolation: '23503',
  restrictViolation: '23001',
  notNullViolation: '23502',
} as const;

// ----------------------------------------------------------------- fixtures SQL
// Escritas em SQL cru de propósito: provam que o BANCO aplica as invariantes,
// independentemente do código de aplicação.

export interface TxRow {
  id?: string;
  providerId?: string;
  externalTransactionId?: string;
  idempotencyKey?: string;
  walletId: string;
  playerId: string;
  roundId?: string;
  kind: string;
  amount: string;
  currency?: string;
  referenceExternalTransactionId?: string | null;
  referenceTransactionId?: string | null;
  status?: string;
}

export async function insertTx(em: EntityManager, row: TxRow): Promise<string> {
  const id = row.id ?? uuid();
  const ext = row.externalTransactionId ?? `ext-${id}`;
  const provider = row.providerId ?? 'provider-a';
  await em.execute(
    `insert into wager_transactions
      (id, provider_id, external_transaction_id, idempotency_key, payload_hash, wallet_id, player_id,
       round_id, game_id, kind, amount, currency, reference_external_transaction_id, reference_transaction_id,
       status, attempts, created_at, updated_at)
     values (?, ?, ?, ?, ?, ?, ?, ?, 'game', ?, ?, ?, ?, ?, ?, 0, now(), now())`,
    [
      id, provider, ext, row.idempotencyKey ?? `${provider}:${ext}`, hash(), row.walletId, row.playerId,
      row.roundId ?? 'round-1', row.kind, row.amount, row.currency ?? 'BRL',
      row.referenceExternalTransactionId ?? null, row.referenceTransactionId ?? null, row.status ?? 'PENDING',
    ],
  );
  return id;
}

export async function markProcessed(em: EntityManager, txId: string, resultBalance: string, currency = 'BRL') {
  await em.execute(
    `update wager_transactions
        set status = 'PROCESSED', processed_at = now(), updated_at = now(),
            result_balance_amount = ?, result_balance_currency = ?
      where id = ?`,
    [resultBalance, currency, txId],
  );
}

export interface LedgerRow {
  walletId: string;
  transactionId: string;
  direction: 'DEBIT' | 'CREDIT';
  amount: string;
  before: string;
  after: string;
  sequence: number;
  currency?: string;
}

export async function insertLedger(em: EntityManager, r: LedgerRow): Promise<string> {
  const id = uuid();
  await em.execute(
    `insert into wallet_ledger_entries
      (id, wallet_id, transaction_id, direction, amount, currency, balance_before, balance_after, sequence, created_at)
     values (?, ?, ?, ?, ?, ?, ?, ?, ?, now())`,
    [id, r.walletId, r.transactionId, r.direction, r.amount, r.currency ?? 'BRL', r.before, r.after, r.sequence],
  );
  return id;
}

export interface WalletFixture {
  walletId: string;
  playerId: string;
}

/** Abre wallet do jeito correto: wallet + OPENING + CREDIT na mesma transação SQL. */
export async function openWalletSql(orm: MikroORM, balance = '100.00', currency = 'BRL'): Promise<WalletFixture> {
  const walletId = uuid();
  const playerId = uuid();
  await orm.em.fork().transactional(async (em) => {
    await em.execute(
      `insert into wallets (id, player_id, currency, balance_amount, version, created_at, updated_at)
       values (?, ?, ?, ?, 1, now(), now())`,
      [walletId, playerId, currency, balance],
    );
    if (balance !== '0.00') {
      const txId = uuid();
      await em.execute(
        `insert into wager_transactions
          (id, provider_id, external_transaction_id, idempotency_key, payload_hash, wallet_id, player_id, round_id,
           game_id, kind, amount, currency, status, result_balance_amount, result_balance_currency, attempts,
           processed_at, created_at, updated_at)
         values (?, 'internal', ?, ?, 'internal', ?, ?, 'opening', 'internal', 'OPENING', ?, ?, 'PROCESSED', ?, ?, 0,
                 now(), now(), now())`,
        [txId, `opening:${walletId}`, `internal:opening:${walletId}`, walletId, playerId, balance, currency, balance, currency],
      );
      await insertLedger(em, {
        walletId, transactionId: txId, direction: 'CREDIT', amount: balance, before: '0.00', after: balance, sequence: 1, currency,
      });
    }
  });
  return { walletId, playerId };
}

/**
 * Aplica uma operação que move saldo do jeito correto (tx → PROCESSED, wallet, ledger).
 * Devolve o id da transação. Executa dentro de `em` (o chamador controla o commit).
 */
export async function applyMovement(
  em: EntityManager,
  w: WalletFixture,
  opts: { kind: string; amount: string; direction: 'DEBIT' | 'CREDIT'; referenceTransactionId?: string; referenceExternal?: string },
): Promise<string> {
  const [wallet] = await em.execute<{ balance_amount: string; version: number }[]>(
    'select balance_amount, version from wallets where id = ? for update',
    [w.walletId],
  );
  const before = wallet!.balance_amount;
  const after = (await em.execute<{ v: string }[]>(
    `select (?::numeric ${opts.direction === 'CREDIT' ? '+' : '-'} ?::numeric)::text as v`,
    [before, opts.amount],
  ))[0]!.v;
  const txId = await insertTx(em, {
    walletId: w.walletId, playerId: w.playerId, kind: opts.kind, amount: opts.amount,
    referenceExternalTransactionId: opts.referenceExternal ?? null,
    referenceTransactionId: opts.referenceTransactionId ?? null,
  });
  await em.execute(
    `update wager_transactions set status = 'PROCESSED', processed_at = now(), updated_at = now(),
       result_balance_amount = ?, result_balance_currency = 'BRL', reference_transaction_id = ? where id = ?`,
    [after, opts.referenceTransactionId ?? null, txId],
  );
  await em.execute('update wallets set balance_amount = ?, version = version + 1, updated_at = now() where id = ?', [
    after, w.walletId,
  ]);
  await insertLedger(em, {
    walletId: w.walletId, transactionId: txId, direction: opts.direction, amount: opts.amount,
    before, after, sequence: wallet!.version + 1,
  });
  return txId;
}
