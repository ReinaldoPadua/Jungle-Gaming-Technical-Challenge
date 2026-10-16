import { describe, expect, test } from 'bun:test';
import { CurrencyMismatchError, InvalidArgumentError, InvariantViolationError } from '../../src/shared/domain/errors';
import { Money } from '../../src/shared/domain/money';
import { LedgerDirection } from '../../src/modules/wallet/domain/ledger-direction';
import { Wallet } from '../../src/modules/wallet/domain/wallet';
import { WalletLedgerEntry } from '../../src/modules/wallet/domain/wallet-ledger-entry';
import { InsufficientFundsError } from '../../src/modules/wallet/domain/wallet.errors';
import { at, brl, nextId, openWallet, T0, usd } from './fixtures/builders';

const mv = (amount: string, ms = 1) => ({ entryId: nextId('e'), transactionId: nextId('t'), money: brl(amount), at: at(ms) });

/** saldo reconstruído pelo ledger */
const replay = (currency: string, entries: WalletLedgerEntry[]) =>
  entries.reduce((acc, e) => acc.add(e.signedAmount()), Money.zero(currency));

describe('Wallet.open', () => {
  test('saldo inicial > 0 gera lançamento CREDIT de abertura com sequence 1 e version 1', () => {
    const { wallet, openingEntry } = Wallet.open({
      id: 'w', playerId: 'p', initialBalance: brl('1000.00'), openingTransactionId: 'tx-open', openingEntryId: 'e-open', at: T0,
    });
    expect(wallet.version).toBe(1);
    expect(wallet.balance.amount).toBe('1000.00');
    expect(wallet.currency).toBe('BRL');
    expect(openingEntry).toBeDefined();
    expect(openingEntry!.direction).toBe(LedgerDirection.Credit);
    expect(openingEntry!.balanceBefore.amount).toBe('0.00');
    expect(openingEntry!.balanceAfter.amount).toBe('1000.00');
    expect(openingEntry!.sequence).toBe(1);
    expect(openingEntry!.transactionId).toBe('tx-open');
  });

  test('saldo inicial zero não gera lançamento', () => {
    const { wallet, openingEntry } = Wallet.open({ id: 'w', playerId: 'p', initialBalance: Money.zero('BRL'), at: T0 });
    expect(openingEntry).toBeUndefined();
    expect(wallet.version).toBe(1);
    expect(wallet.balance.isZero()).toBe(true);
  });

  test('saldo inicial > 0 sem ids de abertura é erro de programação', () => {
    expect(() => Wallet.open({ id: 'w', playerId: 'p', initialBalance: brl('1.00'), at: T0 })).toThrow(InvariantViolationError);
  });
});

describe('Wallet — débito e crédito', () => {
  test('debit reduz o saldo, incrementa version e devolve lançamento consistente', () => {
    const w = openWallet('100.00');
    const e = w.debit(mv('25.00'));
    expect(w.balance.amount).toBe('75.00');
    expect(w.version).toBe(2);
    expect(e.direction).toBe(LedgerDirection.Debit);
    expect(e.balanceBefore.amount).toBe('100.00');
    expect(e.balanceAfter.amount).toBe('75.00');
    expect(e.sequence).toBe(w.version);
    expect(e.isBalanced()).toBe(true);
  });

  test('credit aumenta o saldo e incrementa version', () => {
    const w = openWallet('10.00');
    const e = w.credit(mv('5.50'));
    expect(w.balance.amount).toBe('15.50');
    expect(w.version).toBe(2);
    expect(e.direction).toBe(LedgerDirection.Credit);
  });

  test('debitar exatamente o saldo leva a zero', () => {
    const w = openWallet('80.00');
    w.debit(mv('80.00'));
    expect(w.balance.isZero()).toBe(true);
  });

  test('saldo nunca fica negativo: debit maior que saldo lança e não altera o agregado', () => {
    const w = openWallet('100.00');
    expect(() => w.debit(mv('100.01'))).toThrow(InsufficientFundsError);
    expect(w.balance.amount).toBe('100.00');
    expect(w.version).toBe(1);
  });

  test('cenário da seção 8 em sequência: 100 − 80 ok, segunda de 80 falha, saldo 20', () => {
    const w = openWallet('100.00');
    w.debit(mv('80.00'));
    expect(() => w.debit(mv('80.00'))).toThrow(InsufficientFundsError);
    expect(w.balance.amount).toBe('20.00');
    expect(w.version).toBe(2);
  });

  test('moeda diferente da wallet lança CurrencyMismatchError e não altera nada', () => {
    const w = openWallet('100.00');
    expect(() => w.credit({ ...mv('1.00'), money: usd('1.00') })).toThrow(CurrencyMismatchError);
    expect(w.version).toBe(1);
  });

  test('valor zero é rejeitado (não existe movimentação vazia)', () => {
    const w = openWallet('100.00');
    expect(() => w.debit(mv('0.00'))).toThrow(InvalidArgumentError);
    expect(w.version).toBe(1);
  });

  test('version só muda quando o saldo muda (falhas não incrementam)', () => {
    const w = openWallet('10.00');
    expect(() => w.debit(mv('20.00'))).toThrow();
    expect(() => w.credit({ ...mv('1.00'), money: usd('1.00') })).toThrow();
    expect(w.version).toBe(1);
    w.credit(mv('1.00'));
    expect(w.version).toBe(2);
  });

  test('saldo == reconstrução pelo ledger após sequência de operações', () => {
    const opened = Wallet.open({ id: 'w', playerId: 'p', initialBalance: brl('50.00'), openingTransactionId: 't0', openingEntryId: 'e0', at: T0 });
    const w = opened.wallet;
    const entries = [opened.openingEntry!];
    entries.push(w.debit(mv('10.00')), w.credit(mv('0.30')), w.debit(mv('40.30')), w.credit(mv('7.77')));
    expect(w.balance.equals(replay('BRL', entries))).toBe(true);
    // cadeia contínua: before[n] == after[n-1] e sequence crescente
    for (let i = 1; i < entries.length; i++) {
      expect(entries[i]!.balanceBefore.equals(entries[i - 1]!.balanceAfter)).toBe(true);
      expect(entries[i]!.sequence).toBe(entries[i - 1]!.sequence + 1);
    }
  });

  test('rehydrate reconstrói o estado sem revalidar', () => {
    const w = openWallet('42.00');
    const copy = Wallet.rehydrate(w.toState());
    expect(copy.balance.equals(w.balance)).toBe(true);
    expect(copy.version).toBe(w.version);
  });
});

describe('WalletLedgerEntry', () => {
  const base = {
    id: 'e', walletId: 'w', transactionId: 't', direction: LedgerDirection.Debit,
    money: brl('10.00'), balanceBefore: brl('100.00'), balanceAfter: brl('90.00'), sequence: 2, createdAt: T0,
  };

  test('create aceita lançamento balanceado e congela a instância', () => {
    const e = WalletLedgerEntry.create(base);
    expect(e.isBalanced()).toBe(true);
    expect(Object.isFrozen(e)).toBe(true);
    expect(e.signedAmount().amount).toBe('-10.00');
  });

  test('create rejeita aritmética inconsistente', () => {
    expect(() => WalletLedgerEntry.create({ ...base, balanceAfter: brl('91.00') })).toThrow(InvariantViolationError);
    expect(() => WalletLedgerEntry.create({ ...base, direction: LedgerDirection.Credit })).toThrow(InvariantViolationError);
  });

  test('create rejeita valor não positivo, saldo negativo e sequence inválida', () => {
    expect(() => WalletLedgerEntry.create({ ...base, money: brl('0.00'), balanceAfter: brl('100.00') })).toThrow(InvariantViolationError);
    expect(() =>
      WalletLedgerEntry.create({ ...base, balanceBefore: brl('5.00'), balanceAfter: brl('5.00').subtract(brl('10.00')) }),
    ).toThrow(InvariantViolationError);
    expect(() => WalletLedgerEntry.create({ ...base, sequence: 0 })).toThrow(InvariantViolationError);
  });

  test('create rejeita moedas misturadas', () => {
    expect(() => WalletLedgerEntry.create({ ...base, money: usd('10.00') })).toThrow(CurrencyMismatchError);
  });

  test('imutabilidade estrutural: atribuição falha', () => {
    const e = WalletLedgerEntry.create(base) as unknown as Record<string, unknown>;
    expect(() => {
      e.balanceAfter = brl('0.00');
    }).toThrow();
  });
});
