import { describe, expect, test } from 'bun:test';
import { Money } from '../../src/shared/domain/money';
import { LedgerDirection } from '../../src/modules/wallet/domain/ledger-direction';
import { Wallet } from '../../src/modules/wallet/domain/wallet';
import { FailureCode } from '../../src/modules/wagering/domain/failure-code';
import type { WagerTransaction } from '../../src/modules/wagering/domain/wager-transaction';
import { settle, type SettlementOutcome } from '../../src/modules/wagering/domain/wager-settlement';
import { WagerTransactionStatus as Status } from '../../src/modules/wagering/domain/wager-transaction-status';
import {
  at, bet, brl, FAST_RETRY, loss, nextId, openWallet, PLAYER_ID, refundOf, rollbackOf, T0, usd, WALLET_ID, win,
} from './fixtures/builders';

interface Ctx {
  wallet: Wallet | undefined;
  /** todas as transações conhecidas (simula o repositório) */
  known: WagerTransaction[];
}

/** Executa settle como o use case fará: resolve referência e reversões no "repositório" em memória. */
function run(ctx: Ctx, tx: WagerTransaction, now = at(1)): SettlementOutcome {
  const reference = tx.referenceExternalTransactionId
    ? ctx.known.find((k) => k.providerId === tx.providerId && k.externalTransactionId === tx.referenceExternalTransactionId)
    : undefined;
  const reversalsOfReference = reference ? ctx.known.filter((k) => k.referenceTransactionId === reference.id) : [];
  const outcome = settle({
    tx, wallet: ctx.wallet, reference, reversalsOfReference, ledgerEntryId: nextId('entry'), now, retryPolicy: FAST_RETRY,
  });
  if (!ctx.known.includes(tx)) ctx.known.push(tx);
  return outcome;
}

const newCtx = (initial = '100.00'): Ctx => ({ wallet: openWallet(initial), known: [] });

describe('BET', () => {
  test('debita o saldo e gera 1 lançamento DEBIT', () => {
    const ctx = newCtx('100.00');
    const tx = bet('25.00');
    const out = run(ctx, tx);
    expect(out.type).toBe('processed');
    if (out.type !== 'processed') throw new Error();
    expect(out.entry!.direction).toBe(LedgerDirection.Debit);
    expect(ctx.wallet!.balance.amount).toBe('75.00');
    expect(tx.status).toBe(Status.Processed);
    expect(tx.resultBalance!.amount).toBe('75.00');
  });

  test('saldo insuficiente → REJECTED INSUFFICIENT_FUNDS, sem ledger, saldo intacto', () => {
    const ctx = newCtx('10.00');
    const tx = bet('10.01');
    expect(run(ctx, tx)).toEqual({ type: 'rejected', code: FailureCode.InsufficientFunds });
    expect(ctx.wallet!.balance.amount).toBe('10.00');
    expect(ctx.wallet!.version).toBe(1);
    expect(tx.resultBalance!.amount).toBe('10.00');
  });

  test('cenário obrigatório (sequencial): 100 com duas BET de 80 → 1 PROCESSED, 1 REJECTED, saldo 20', () => {
    const ctx = newCtx('100.00');
    const [a, b] = [bet('80.00'), bet('80.00')];
    const outs = [run(ctx, a), run(ctx, b)].map((o) => o.type);
    expect(outs).toEqual(['processed', 'rejected']);
    expect(ctx.wallet!.balance.amount).toBe('20.00');
    expect(b.failureCode).toBe(FailureCode.InsufficientFunds);
  });
});

describe('WIN', () => {
  test('credita o saldo', () => {
    const ctx = newCtx('0.00');
    const out = run(ctx, win('50.00'));
    expect(out.type).toBe('processed');
    expect(ctx.wallet!.balance.amount).toBe('50.00');
  });

  test('pode referenciar a BET da mesma rodada', () => {
    const ctx = newCtx('100.00');
    const b = bet('10.00');
    run(ctx, b);
    const w = win('30.00', { referenceExternalTransactionId: b.externalTransactionId });
    expect(run(ctx, w).type).toBe('processed');
    expect(w.referenceTransactionId).toBe(b.id);
    expect(ctx.wallet!.balance.amount).toBe('120.00');
  });

  test('referência de outra rodada → REFERENCE_MISMATCH', () => {
    const ctx = newCtx('100.00');
    const b = bet('10.00', { roundId: 'other-round' });
    run(ctx, b);
    const w = win('30.00', { referenceExternalTransactionId: b.externalTransactionId });
    expect(run(ctx, w)).toEqual({ type: 'rejected', code: FailureCode.ReferenceMismatch });
  });
});

describe('LOSS', () => {
  test('é PROCESSED sem mover saldo e sem lançamento', () => {
    const ctx = newCtx('100.00');
    const tx = loss('25.00');
    const out = run(ctx, tx);
    expect(out).toEqual({ type: 'processed', entry: undefined });
    expect(ctx.wallet!.balance.amount).toBe('100.00');
    expect(ctx.wallet!.version).toBe(1);
    expect(tx.resultBalance!.amount).toBe('100.00');
  });
});

describe('REFUND', () => {
  test('reverte uma BET PROCESSED creditando o mesmo valor', () => {
    const ctx = newCtx('100.00');
    const b = bet('40.00');
    run(ctx, b);
    const r = refundOf(b);
    const out = run(ctx, r);
    expect(out.type).toBe('processed');
    if (out.type !== 'processed') throw new Error();
    expect(out.entry!.direction).toBe(LedgerDirection.Credit);
    expect(ctx.wallet!.balance.amount).toBe('100.00');
    expect(r.referenceTransactionId).toBe(b.id);
  });

  test('só uma vez: segundo REFUND → ALREADY_REVERSED', () => {
    const ctx = newCtx('100.00');
    const b = bet('40.00');
    run(ctx, b);
    run(ctx, refundOf(b));
    expect(run(ctx, refundOf(b))).toEqual({ type: 'rejected', code: FailureCode.AlreadyReversed });
    expect(ctx.wallet!.balance.amount).toBe('100.00');
  });

  test('só referencia BET → REFERENCE_INVALID_KIND', () => {
    const ctx = newCtx('100.00');
    const w = win('10.00');
    run(ctx, w);
    expect(run(ctx, refundOf(w))).toEqual({ type: 'rejected', code: FailureCode.ReferenceInvalidKind });
  });

  test('valor diferente da referência → REFERENCE_AMOUNT_MISMATCH', () => {
    const ctx = newCtx('100.00');
    const b = bet('40.00');
    run(ctx, b);
    expect(run(ctx, refundOf(b, { money: brl('39.99') }))).toEqual({
      type: 'rejected', code: FailureCode.ReferenceAmountMismatch,
    });
  });

  test('referência REJECTED → REFERENCE_NOT_PROCESSED', () => {
    const ctx = newCtx('10.00');
    const b = bet('40.00');
    run(ctx, b); // rejeitada por saldo
    expect(run(ctx, refundOf(b))).toEqual({ type: 'rejected', code: FailureCode.ReferenceNotProcessed });
  });

  test.each([
    ['player', { playerId: 'other-player' }],
    ['provider', { providerId: 'provider-b' }],
  ] as const)('referência de outro %s não é resolvida/aceita', (_label, override) => {
    const ctx = newCtx('100.00');
    const b = bet('10.00', override as Record<string, string>);
    ctx.known.push(b); // existe, mas pertence a outro escopo
    b.markProcessed(undefined, T0, brl('90.00'));
    const r = refundOf(b);
    const out = run(ctx, r);
    // outro provider → nem é encontrada (lookup é por providerId) → pendente;
    // outro player (mesmo provider) → encontrada e rejeitada por mismatch
    if (_label === 'provider') expect(out.type).toBe('pending_reference');
    else expect(out).toEqual({ type: 'rejected', code: FailureCode.ReferenceMismatch });
  });
});

describe('ROLLBACK', () => {
  test('de BET → crédito', () => {
    const ctx = newCtx('100.00');
    const b = bet('30.00');
    run(ctx, b);
    expect(run(ctx, rollbackOf(b)).type).toBe('processed');
    expect(ctx.wallet!.balance.amount).toBe('100.00');
  });

  test('de WIN → débito', () => {
    const ctx = newCtx('0.00');
    const w = win('50.00');
    run(ctx, w);
    expect(run(ctx, rollbackOf(w)).type).toBe('processed');
    expect(ctx.wallet!.balance.amount).toBe('0.00');
  });

  test('de REFUND → débito (desfaz o reembolso)', () => {
    const ctx = newCtx('100.00');
    const b = bet('20.00');
    run(ctx, b);
    const r = refundOf(b);
    run(ctx, r);
    expect(run(ctx, rollbackOf(r)).type).toBe('processed');
    expect(ctx.wallet!.balance.amount).toBe('80.00');
  });

  test('de WIN já gasto → REVERSAL_WOULD_OVERDRAW (código distinto de INSUFFICIENT_FUNDS)', () => {
    const ctx = newCtx('0.00');
    const w = win('50.00');
    run(ctx, w);
    run(ctx, bet('40.00')); // jogador gastou parte do prêmio
    const rb = rollbackOf(w);
    expect(run(ctx, rb)).toEqual({ type: 'rejected', code: FailureCode.ReversalWouldOverdraw });
    expect(ctx.wallet!.balance.amount).toBe('10.00');
    expect(rb.status).toBe(Status.Rejected); // permanece auditável
  });

  test('não reverte ROLLBACK nem LOSS → REFERENCE_INVALID_KIND', () => {
    const ctx = newCtx('100.00');
    const b = bet('10.00');
    run(ctx, b);
    const rb = rollbackOf(b);
    run(ctx, rb);
    expect(run(ctx, rollbackOf(rb))).toEqual({ type: 'rejected', code: FailureCode.ReferenceInvalidKind });
    const l = loss('0.00');
    run(ctx, l);
    expect(run(ctx, rollbackOf(l, { money: brl('1.00') }))).toEqual({ type: 'rejected', code: FailureCode.ReferenceInvalidKind });
  });

  test('uma transação só é revertida uma vez, por qualquer tipo: REFUND depois de ROLLBACK → ALREADY_REVERSED', () => {
    const ctx = newCtx('100.00');
    const b = bet('10.00');
    run(ctx, b);
    run(ctx, rollbackOf(b));
    expect(run(ctx, refundOf(b))).toEqual({ type: 'rejected', code: FailureCode.AlreadyReversed });
    expect(run(ctx, rollbackOf(b))).toEqual({ type: 'rejected', code: FailureCode.AlreadyReversed });
    expect(ctx.wallet!.balance.amount).toBe('100.00');
  });
});

describe('Referências fora de ordem', () => {
  test('ROLLBACK antes da BET → PENDING_REFERENCE; depois que a BET chega, reprocessa e aplica', () => {
    const ctx = newCtx('100.00');
    const b = bet('25.00');
    const rb = rollbackOf(b);
    expect(run(ctx, rb, at(0)).type).toBe('pending_reference');
    expect(rb.status).toBe(Status.PendingReference);
    expect(ctx.wallet!.balance.amount).toBe('100.00');

    run(ctx, b, at(10));
    expect(ctx.wallet!.balance.amount).toBe('75.00');

    expect(run(ctx, rb, at(200)).type).toBe('processed');
    expect(ctx.wallet!.balance.amount).toBe('100.00');
  });

  test('referência ainda PENDING_REFERENCE faz o dependente esperar', () => {
    const ctx = newCtx('100.00');
    const b = bet('10.00');
    const r = refundOf(b);
    const rbOfRefund = rollbackOf(r);
    run(ctx, r); // REFUND pendente (BET não chegou)
    expect(run(ctx, rbOfRefund).type).toBe('pending_reference');
  });

  test('esgotado o limite → REJECTED REFERENCE_NOT_FOUND', () => {
    const ctx = newCtx('100.00');
    const rb = rollbackOf(bet('5.00'));
    for (let i = 0; i < FAST_RETRY.maxAttempts; i++) expect(run(ctx, rb, at(i)).type).toBe('pending_reference');
    expect(run(ctx, rb, at(99))).toEqual({ type: 'rejected', code: FailureCode.ReferenceNotFound });
    expect(rb.status).toBe(Status.Rejected);
  });
});

describe('Validações de wallet', () => {
  test('wallet inexistente → WALLET_NOT_FOUND', () => {
    const tx = bet('1.00');
    expect(run({ wallet: undefined, known: [] }, tx)).toEqual({ type: 'rejected', code: FailureCode.WalletNotFound });
    expect(tx.resultBalance).toBeUndefined();
  });

  test('wallet de outro player → WALLET_PLAYER_MISMATCH', () => {
    expect(run(newCtx(), bet('1.00', { playerId: 'intruder' }))).toEqual({
      type: 'rejected', code: FailureCode.WalletPlayerMismatch,
    });
  });

  test('conflito de moeda → CURRENCY_MISMATCH, sem alterar saldo', () => {
    const ctx = newCtx('100.00');
    const tx = bet('1.00', { money: usd('1.00') });
    expect(run(ctx, tx)).toEqual({ type: 'rejected', code: FailureCode.CurrencyMismatch });
    expect(ctx.wallet!.version).toBe(1);
  });

  test('wallet multi-moeda: uma wallet USD aceita USD', () => {
    const wallet = Wallet.open({ id: WALLET_ID, playerId: PLAYER_ID, initialBalance: Money.zero('USD'), at: T0 }).wallet;
    expect(run({ wallet, known: [] }, win('5.00', { money: usd('5.00') })).type).toBe('processed');
    expect(wallet.balance.toString()).toBe('5.00 USD');
  });
});

test('invariante final: saldo == reconstrução pelo ledger após mix de operações', () => {
  const opened = Wallet.open({
    id: WALLET_ID, playerId: PLAYER_ID, initialBalance: brl('100.00'), openingTransactionId: 'o', openingEntryId: 'oe', at: T0,
  });
  const ctx: Ctx = { wallet: opened.wallet, known: [] };
  const entries = [opened.openingEntry!];
  const b1 = bet('30.00');
  const b2 = bet('500.00');
  const w1 = win('12.34', { referenceExternalTransactionId: b1.externalTransactionId });
  const ops = [b1, b2, w1, loss('0.00'), bet('20.00'), refundOf(b1), rollbackOf(w1), refundOf(b1)];
  for (const op of ops) {
    const out = run(ctx, op);
    if (out.type === 'processed' && out.entry) entries.push(out.entry);
  }
  const rebuilt = entries.reduce((acc, e) => acc.add(e.signedAmount()), Money.zero('BRL'));
  expect(ctx.wallet!.balance.equals(rebuilt)).toBe(true);
  expect(ctx.wallet!.balance.amount).toBe('80.00');
});
