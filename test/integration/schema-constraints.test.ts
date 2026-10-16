/**
 * Restrição 9 do desafio: unicidade, imutabilidade e não-negatividade aplicadas
 * NO SCHEMA. Todos os casos usam SQL cru, sem passar pelo domínio.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import type { MikroORM } from '@mikro-orm/postgresql';
import { initOrm } from '../helpers/infra';
import {
  applyMovement, expectSqlState, insertLedger, insertTx, markProcessed, migrateFresh, openWalletSql,
  SQLSTATE, truncateAll, uuid, type WalletFixture,
} from '../helpers/db';

let orm: MikroORM;
const tx = <T>(fn: Parameters<MikroORM['em']['transactional']>[0]) => orm.em.fork().transactional(fn) as Promise<T>;
const exec = (sql: string, params: unknown[] = []) => orm.em.getConnection().execute(sql, params);
const one = async <T>(sql: string, params: unknown[] = []) => ((await exec(sql, params)) as T[])[0]!;

beforeAll(async () => {
  orm = await initOrm();
  await migrateFresh(orm);
});
afterAll(async () => {
  await orm?.close(true);
});
beforeEach(async () => {
  await truncateAll(orm);
});

// ================================================================== migrations
describe('migrations', () => {
  const tables = async () =>
    ((await exec(`select table_name from information_schema.tables where table_schema = 'public' order by 1`)) as {
      table_name: string;
    }[]).map((r) => r.table_name);

  test('são reversíveis: down remove tudo, up recria tudo', async () => {
    const migrator = orm.getMigrator();
    await migrator.down({ to: 0 });
    expect(await tables()).toEqual(['mikro_orm_migrations']);
    await migrator.up();
    expect(await tables()).toEqual([
      'inbox_messages', 'mikro_orm_migrations', 'outbox_messages', 'wager_transactions', 'wallet_ledger_entries', 'wallets',
    ]);
  });

  test('toda coluna mapeada pelo MikroORM existe no banco', async () => {
    const cols = new Set(
      ((await exec(`select table_name || '.' || column_name as c from information_schema.columns where table_schema = 'public'`)) as {
        c: string;
      }[]).map((r) => r.c),
    );
    const missing: string[] = [];
    for (const meta of Object.values(orm.getMetadata().getAll())) {
      for (const prop of meta.props) for (const f of prop.fieldNames ?? []) if (!cols.has(`${meta.tableName}.${f}`)) missing.push(`${meta.tableName}.${f}`);
    }
    expect(missing).toEqual([]);
  });
});

// ===================================================================== wallets
describe('wallets', () => {
  test('caminho feliz: abertura com OPENING + CREDIT confirma', async () => {
    const w = await openWalletSql(orm, '100.00');
    const row = await one<{ balance_amount: string; version: number }>('select balance_amount, version from wallets where id = ?', [w.walletId]);
    expect(row).toEqual({ balance_amount: '100.00', version: 1 });
  });

  test('saldo negativo é rejeitado', async () => {
    const w = await openWalletSql(orm, '0.00');
    await expectSqlState(
      exec(`update wallets set balance_amount = -1, version = 2 where id = ?`, [w.walletId]),
      SQLSTATE.checkViolation, 'wallets_balance_non_negative',
    );
  });

  test('uma wallet por (player, moeda)', async () => {
    const w = await openWalletSql(orm, '0.00');
    await expectSqlState(
      exec(`insert into wallets values (?, ?, 'BRL', 0, 1, now(), now())`, [uuid(), w.playerId]),
      SQLSTATE.uniqueViolation, 'wallets_player_currency_uq',
    );
    // mesma pessoa, outra moeda: permitido
    await exec(`insert into wallets values (?, ?, 'USD', 0, 1, now(), now())`, [uuid(), w.playerId]);
  });

  test('wallet nasce com version 1', async () => {
    await expectSqlState(
      exec(`insert into wallets values (?, ?, 'BRL', 0, 7, now(), now())`, [uuid(), uuid()]),
      SQLSTATE.checkViolation, /version 1/,
    );
  });

  test('saldo não muda sem incrementar version em exatamente 1', async () => {
    const w = await openWalletSql(orm, '100.00');
    await expectSqlState(exec(`update wallets set balance_amount = 90 where id = ?`, [w.walletId]), SQLSTATE.checkViolation, /increment/);
    await expectSqlState(exec(`update wallets set balance_amount = 90, version = 3 where id = ?`, [w.walletId]), SQLSTATE.checkViolation, /increment/);
  });

  test('version não muda sem o saldo mudar', async () => {
    const w = await openWalletSql(orm, '100.00');
    await expectSqlState(exec(`update wallets set version = 2 where id = ?`, [w.walletId]), SQLSTATE.checkViolation, /together/);
  });

  test('identidade (player, moeda) é imutável e wallet não pode ser excluída', async () => {
    const w = await openWalletSql(orm, '0.00');
    await expectSqlState(exec(`update wallets set currency = 'USD' where id = ?`, [w.walletId]), SQLSTATE.restrictViolation);
    await expectSqlState(exec(`update wallets set player_id = ? where id = ?`, [uuid(), w.walletId]), SQLSTATE.restrictViolation);
    await expectSqlState(exec(`delete from wallets where id = ?`, [w.walletId]), SQLSTATE.restrictViolation);
  });

  test('mudança de saldo sem lançamento no ledger é barrada no COMMIT', async () => {
    const w = await openWalletSql(orm, '100.00');
    await expectSqlState(
      tx(async (em) => {
        await em.execute(`update wallets set balance_amount = 90, version = 2 where id = ?`, [w.walletId]);
      }),
      SQLSTATE.checkViolation, /no matching ledger entry/,
    );
    const row = await one<{ balance_amount: string }>('select balance_amount from wallets where id = ?', [w.walletId]);
    expect(row.balance_amount).toBe('100.00'); // rollback total
  });

  test('wallet criada com saldo > 0 sem lançamento de abertura é barrada no COMMIT', async () => {
    await expectSqlState(
      tx(async (em) => {
        await em.execute(`insert into wallets values (?, ?, 'BRL', 50, 1, now(), now())`, [uuid(), uuid()]);
      }),
      SQLSTATE.checkViolation, /no matching ledger entry/,
    );
  });
});

// ========================================================== wager_transactions
describe('wager_transactions', () => {
  let w: WalletFixture;
  beforeEach(async () => {
    w = await openWalletSql(orm, '100.00');
  });
  const base = () => ({ walletId: w.walletId, playerId: w.playerId, kind: 'BET', amount: '10.00' });

  test('idempotency_key é única', async () => {
    await insertTx(orm.em.fork(), { ...base(), idempotencyKey: 'k-1' });
    await expectSqlState(insertTx(orm.em.fork(), { ...base(), idempotencyKey: 'k-1' }), SQLSTATE.uniqueViolation, 'wtx_idempotency_key_uq');
  });

  test('(provider_id, external_transaction_id) é única mesmo com outra idempotency key', async () => {
    await insertTx(orm.em.fork(), { ...base(), externalTransactionId: 'ext-1', idempotencyKey: 'a' });
    await expectSqlState(
      insertTx(orm.em.fork(), { ...base(), externalTransactionId: 'ext-1', idempotencyKey: 'b' }),
      SQLSTATE.uniqueViolation, 'wtx_provider_external_uq',
    );
    // mesmo external id em outro provider: permitido
    await insertTx(orm.em.fork(), { ...base(), providerId: 'provider-b', externalTransactionId: 'ext-1' });
  });

  test.each([
    ['kind inválido', { kind: 'JACKPOT' }, 'wtx_kind_valid'],
    ['valor negativo', { amount: '-1.00' }, 'wtx_amount_non_negative'],
    ['BET com valor zero', { amount: '0.00' }, 'wtx_amount_positive'],
    ['REFUND sem referência', { kind: 'REFUND' }, 'wtx_reference_required'],
    ['BET com referência', { referenceExternalTransactionId: 'x' }, 'wtx_reference_forbidden'],
    ['moeda inválida', { currency: 'brl' }, 'wtx_currency_format'],
    ['OPENING de provider externo', { kind: 'OPENING' }, 'wtx_internal_provider'],
  ])('CHECK: %s', async (_label, override, constraint) => {
    await expectSqlState(insertTx(orm.em.fork(), { ...base(), ...override }), SQLSTATE.checkViolation, constraint);
  });

  test('CHECK: status inválido', async () => {
    const id = await insertTx(orm.em.fork(), base());
    await expectSqlState(exec(`update wager_transactions set status = 'DONE' where id = ?`, [id]), SQLSTATE.checkViolation, 'wtx_status_valid');
  });

  test('LOSS aceita valor zero', async () => {
    await insertTx(orm.em.fork(), { ...base(), kind: 'LOSS', amount: '0.00' });
  });

  test('transação só pode ser inserida como PENDING', async () => {
    await expectSqlState(insertTx(orm.em.fork(), { ...base(), status: 'PROCESSED' }), SQLSTATE.checkViolation, /inserted as PENDING/);
  });

  test('estados terminais são imutáveis', async () => {
    const id = await insertTx(orm.em.fork(), { ...base(), kind: 'LOSS', amount: '0.00' });
    await markProcessed(orm.em.fork(), id, '100.00');
    await expectSqlState(
      exec(`update wager_transactions set status = 'REJECTED', failure_code = 'INSUFFICIENT_FUNDS' where id = ?`, [id]),
      SQLSTATE.restrictViolation, /terminal/,
    );
    await expectSqlState(exec(`update wager_transactions set updated_at = now() where id = ?`, [id]), SQLSTATE.restrictViolation, /terminal/);
  });

  test('campos da requisição são imutáveis mesmo antes do estado terminal', async () => {
    const id = await insertTx(orm.em.fork(), base());
    await expectSqlState(exec(`update wager_transactions set amount = 99 where id = ?`, [id]), SQLSTATE.restrictViolation, /immutable/);
    await expectSqlState(exec(`update wager_transactions set payload_hash = 'x' where id = ?`, [id]), SQLSTATE.restrictViolation, /immutable/);
  });

  test('não volta para PENDING e attempts não diminui', async () => {
    const ref = `missing-${uuid()}`;
    const id = await insertTx(orm.em.fork(), { ...base(), kind: 'REFUND', referenceExternalTransactionId: ref });
    await exec(`update wager_transactions set status = 'PENDING_REFERENCE', attempts = 2, next_attempt_at = now() where id = ?`, [id]);
    await expectSqlState(exec(`update wager_transactions set status = 'PENDING' where id = ?`, [id]), SQLSTATE.checkViolation, /-> PENDING/);
    await expectSqlState(exec(`update wager_transactions set attempts = 1 where id = ?`, [id]), SQLSTATE.checkViolation, /decrease/);
  });

  test('PENDING_REFERENCE exige next_attempt_at; REJECTED exige failure_code', async () => {
    const id = await insertTx(orm.em.fork(), base());
    await expectSqlState(exec(`update wager_transactions set status = 'PENDING_REFERENCE' where id = ?`, [id]), SQLSTATE.checkViolation, 'wtx_pending_ref_scheduled');
    await expectSqlState(exec(`update wager_transactions set status = 'REJECTED' where id = ?`, [id]), SQLSTATE.checkViolation, 'wtx_failure_iff_failed');
    await expectSqlState(
      exec(`update wager_transactions set status = 'REJECTED', failure_code = 'NOT_A_CODE' where id = ?`, [id]),
      SQLSTATE.checkViolation, 'wtx_failure_code_valid',
    );
  });

  test('PROCESSED exige saldo resultante; reversão PROCESSED exige referência resolvida', async () => {
    const id = await insertTx(orm.em.fork(), base());
    await expectSqlState(exec(`update wager_transactions set status = 'PROCESSED', processed_at = now() where id = ?`, [id]), SQLSTATE.checkViolation, 'wtx_processed_complete');
    const refund = await insertTx(orm.em.fork(), { ...base(), kind: 'REFUND', referenceExternalTransactionId: 'x' });
    await expectSqlState(markProcessed(orm.em.fork(), refund, '100.00'), SQLSTATE.checkViolation, 'wtx_reversal_resolved');
  });

  test('transações não podem ser excluídas', async () => {
    const id = await insertTx(orm.em.fork(), base());
    await expectSqlState(exec(`delete from wager_transactions where id = ?`, [id]), SQLSTATE.restrictViolation);
  });

  test('referência precisa estar no mesmo wallet/provider/player/rodada/moeda (FK composta)', async () => {
    const betId = await insertTx(orm.em.fork(), { ...base(), roundId: 'round-1' });
    const other = await openWalletSql(orm, '0.00');
    const cases: Record<string, Partial<Parameters<typeof insertTx>[1]>> = {
      'outra wallet': { walletId: other.walletId, playerId: other.playerId },
      'outra rodada': { roundId: 'round-2' },
      'outro provider': { providerId: 'provider-b' },
    };
    for (const [label, override] of Object.entries(cases)) {
      await expectSqlState(
        insertTx(orm.em.fork(), { ...base(), kind: 'REFUND', referenceExternalTransactionId: 'x', referenceTransactionId: betId, ...override }),
        SQLSTATE.foreignKeyViolation, 'wtx_reference_scope_fk',
      ).catch((e) => {
        throw new Error(`${label}: ${e}`);
      });
    }
  });

  test('uma referência é revertida no máximo uma vez (REFUND e depois ROLLBACK da mesma BET)', async () => {
    const betId = await tx<string>((e) => applyMovement(e, w, { kind: 'BET', amount: '10.00', direction: 'DEBIT' }));
    await tx((e) => applyMovement(e, w, { kind: 'REFUND', amount: '10.00', direction: 'CREDIT', referenceTransactionId: betId, referenceExternal: 'b' }));
    await expectSqlState(
      tx((e) => applyMovement(e, w, { kind: 'ROLLBACK', amount: '10.00', direction: 'CREDIT', referenceTransactionId: betId, referenceExternal: 'b' })),
      SQLSTATE.uniqueViolation, 'wtx_single_reversal_uq',
    );
  });

  test('no máximo uma OPENING por wallet', async () => {
    await expectSqlState(
      exec(
        `insert into wager_transactions (id, provider_id, external_transaction_id, idempotency_key, payload_hash, wallet_id,
          player_id, round_id, game_id, kind, amount, currency, status, result_balance_amount, result_balance_currency,
          attempts, processed_at, created_at, updated_at)
         values (?, 'internal', 'opening:dup', 'internal:opening:dup', 'internal', ?, ?, 'opening', 'internal', 'OPENING',
                 1, 'BRL', 'PROCESSED', 1, 'BRL', 0, now(), now(), now())`,
        [uuid(), w.walletId, w.playerId],
      ),
      SQLSTATE.uniqueViolation, 'wtx_single_opening_uq',
    );
  });
});

// ======================================================= wallet_ledger_entries
describe('wallet_ledger_entries', () => {
  let w: WalletFixture;
  beforeEach(async () => {
    w = await openWalletSql(orm, '100.00');
  });

  const pendingBet = (amount = '10.00') => insertTx(orm.em.fork(), { walletId: w.walletId, playerId: w.playerId, kind: 'BET', amount });

  test('caminho feliz: BET, WIN e ROLLBACK de WIN confirmam e a cadeia fecha', async () => {
    await tx((e) => applyMovement(e, w, { kind: 'BET', amount: '30.00', direction: 'DEBIT' }));
    const winId = await tx<string>((e) => applyMovement(e, w, { kind: 'WIN', amount: '12.34', direction: 'CREDIT' }));
    await tx((e) => applyMovement(e, w, { kind: 'ROLLBACK', amount: '12.34', direction: 'DEBIT', referenceTransactionId: winId, referenceExternal: 'w' }));
    const r = await one<{ stored: string; rebuilt: string; n: string }>(
      `select w.balance_amount as stored,
              sum(case e.direction when 'CREDIT' then e.amount else -e.amount end)::numeric(20,2)::text as rebuilt,
              count(*)::text as n
         from wallets w join wallet_ledger_entries e on e.wallet_id = w.id where w.id = ? group by w.balance_amount`,
      [w.walletId],
    );
    expect(r).toEqual({ stored: '70.00', rebuilt: '70.00', n: '4' });
  });

  test('append-only: UPDATE e DELETE são proibidos', async () => {
    await expectSqlState(exec(`update wallet_ledger_entries set amount = 1 where wallet_id = ?`, [w.walletId]), SQLSTATE.restrictViolation, /append-only/);
    await expectSqlState(exec(`delete from wallet_ledger_entries where wallet_id = ?`, [w.walletId]), SQLSTATE.restrictViolation, /append-only/);
  });

  test('aritmética do lançamento é verificada (before ± amount = after)', async () => {
    const txId = await pendingBet();
    await expectSqlState(
      insertLedger(orm.em.fork(), { walletId: w.walletId, transactionId: txId, direction: 'DEBIT', amount: '10.00', before: '100.00', after: '95.00', sequence: 2 }),
      SQLSTATE.checkViolation, 'wle_balanced',
    );
  });

  test('saldo do lançamento nunca negativo', async () => {
    const txId = await pendingBet('200.00');
    await expectSqlState(
      insertLedger(orm.em.fork(), { walletId: w.walletId, transactionId: txId, direction: 'DEBIT', amount: '200.00', before: '100.00', after: '-100.00', sequence: 2 }),
      SQLSTATE.checkViolation, 'wle_balances_non_negative',
    );
  });

  test('valor do lançamento = valor da transação (FK composta)', async () => {
    const txId = await pendingBet('10.00');
    await expectSqlState(
      insertLedger(orm.em.fork(), { walletId: w.walletId, transactionId: txId, direction: 'DEBIT', amount: '9.00', before: '100.00', after: '91.00', sequence: 2 }),
      SQLSTATE.foreignKeyViolation, 'wle_transaction_fk',
    );
  });

  test('moeda do lançamento = moeda da wallet (FK composta)', async () => {
    const txId = await pendingBet();
    await expectSqlState(
      insertLedger(orm.em.fork(), { walletId: w.walletId, transactionId: txId, direction: 'DEBIT', amount: '10.00', before: '100.00', after: '90.00', sequence: 2, currency: 'USD' }),
      SQLSTATE.foreignKeyViolation,
    );
  });

  test('no máximo um lançamento por transação', async () => {
    const txId = await tx<string>((e) => applyMovement(e, w, { kind: 'BET', amount: '10.00', direction: 'DEBIT' }));
    await expectSqlState(
      insertLedger(orm.em.fork(), { walletId: w.walletId, transactionId: txId, direction: 'DEBIT', amount: '10.00', before: '90.00', after: '80.00', sequence: 3 }),
      SQLSTATE.uniqueViolation, 'wle_transaction_wallet_uq',
    );
  });

  test('cadeia contínua: sequence e balance_before continuam do último lançamento', async () => {
    const txId = await pendingBet();
    await expectSqlState(
      insertLedger(orm.em.fork(), { walletId: w.walletId, transactionId: txId, direction: 'DEBIT', amount: '10.00', before: '50.00', after: '40.00', sequence: 2 }),
      SQLSTATE.checkViolation, /chain broken/,
    );
    await expectSqlState(
      insertLedger(orm.em.fork(), { walletId: w.walletId, transactionId: txId, direction: 'DEBIT', amount: '10.00', before: '100.00', after: '90.00', sequence: 5 }),
      SQLSTATE.checkViolation, /chain broken/,
    );
  });

  test('COMMIT barra lançamento de transação não PROCESSED', async () => {
    await expectSqlState(
      tx(async (em) => {
        const txId = await insertTx(em, { walletId: w.walletId, playerId: w.playerId, kind: 'BET', amount: '10.00' });
        await em.execute(`update wallets set balance_amount = 90, version = 2 where id = ?`, [w.walletId]);
        await insertLedger(em, { walletId: w.walletId, transactionId: txId, direction: 'DEBIT', amount: '10.00', before: '100.00', after: '90.00', sequence: 2 });
      }),
      SQLSTATE.checkViolation, /status PENDING/,
    );
  });

  test('COMMIT barra lançamento de LOSS e direção errada', async () => {
    for (const [kind, direction, pattern] of [
      ['LOSS', 'DEBIT', /no entry/],
      ['BET', 'CREDIT', /requires DEBIT/],
      ['WIN', 'DEBIT', /requires CREDIT/],
    ] as const) {
      await expectSqlState(
        tx((e) => applyMovement(e, w, { kind, amount: '10.00', direction })),
        SQLSTATE.checkViolation, pattern,
      );
    }
  });

  test('COMMIT barra lançamento sem a wallet refletir o novo saldo', async () => {
    await expectSqlState(
      tx(async (em) => {
        const txId = await insertTx(em, { walletId: w.walletId, playerId: w.playerId, kind: 'BET', amount: '10.00' });
        await markProcessed(em, txId, '90.00');
        await insertLedger(em, { walletId: w.walletId, transactionId: txId, direction: 'DEBIT', amount: '10.00', before: '100.00', after: '90.00', sequence: 2 });
      }),
      SQLSTATE.checkViolation, /does not reflect/,
    );
  });
});

// ============================================================== inbox / outbox
describe('inbox_messages / outbox_messages', () => {
  test('inbox: (consumer_name, message_id) é único', async () => {
    const ins = () => exec(`insert into inbox_messages values ('wager-consumer', 'msg-1', 'h', now(), null)`);
    await ins();
    await expectSqlState(ins(), SQLSTATE.uniqueViolation, 'inbox_messages_pk');
    // outro consumidor pode receber a mesma mensagem
    await exec(`insert into inbox_messages values ('audit-consumer', 'msg-1', 'h', now(), null)`);
  });

  const outbox = (id: string, payload: object) =>
    exec(
      `insert into outbox_messages (id, aggregate_id, event_type, payload, occurred_at, next_attempt_at)
       values (?, 'agg', 'WalletBalanceChanged', ?::jsonb, now(), now())`,
      [id, JSON.stringify(payload)],
    );

  test('outbox: payload precisa conter o próprio eventId e eventType', async () => {
    await expectSqlState(outbox(uuid(), { eventId: uuid(), eventType: 'WalletBalanceChanged' }), SQLSTATE.checkViolation, 'outbox_payload_matches');
  });

  test('outbox: envelope imutável e publicação definitiva', async () => {
    const id = uuid();
    await outbox(id, { eventId: id, eventType: 'WalletBalanceChanged' });
    await expectSqlState(exec(`update outbox_messages set payload = '{}' where id = ?`, [id]), SQLSTATE.restrictViolation, /immutable/);
    await exec(`update outbox_messages set attempts = 1, last_error = 'boom', next_attempt_at = now() where id = ?`, [id]);
    await exec(`update outbox_messages set published_at = now() where id = ?`, [id]);
    await expectSqlState(exec(`update outbox_messages set published_at = null where id = ?`, [id]), SQLSTATE.restrictViolation, /already published/);
  });
});
