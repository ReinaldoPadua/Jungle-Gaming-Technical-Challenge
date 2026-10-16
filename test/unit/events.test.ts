import { describe, expect, test } from 'bun:test';
import { InvariantViolationError } from '../../src/shared/domain/errors';
import type { EventContext } from '../../src/shared/events/integration-event';
import {
  WagerTransactionPendingReference,
  WagerTransactionProcessed,
  WagerTransactionRejected,
  WalletBalanceChanged,
} from '../../src/modules/wagering/domain/events';
import { FailureCode } from '../../src/modules/wagering/domain/failure-code';
import { at, bet, brl, FAST_RETRY, nextId, openWallet, refundOf, T0 } from './fixtures/builders';

const ctx = (): EventContext => ({ eventId: nextId('evt'), correlationId: 'corr-1', causationId: 'msg-1', occurredAt: T0 });

describe('IntegrationEvent envelope', () => {
  test('WalletBalanceChanged: eventType/version no tipo e data com MoneyProps', () => {
    const w = openWallet('100.00');
    const entry = w.debit({ entryId: 'e', transactionId: 't', money: brl('25.00'), at: at(1) });
    const json = WalletBalanceChanged.from(w, entry, ctx()).toJSON();
    expect(json.eventType).toBe('WalletBalanceChanged');
    expect(json.version).toBe(1);
    expect(json.aggregateId).toBe(w.id);
    expect(json.occurredAt).toBe('2026-07-29T15:00:00.000Z');
    expect(json.causationId).toBe('msg-1');
    // compara o formato de fio (strings), não os enums TS
    expect(JSON.parse(JSON.stringify(json.data))).toEqual({
      walletId: w.id,
      transactionId: 't',
      direction: 'DEBIT',
      money: { amount: '25.00', currency: 'BRL' },
      balanceBefore: { amount: '100.00', currency: 'BRL' },
      balanceAfter: { amount: '75.00', currency: 'BRL' },
      walletVersion: 2,
    });
  });

  test('envelope é JSON estável (round-trip sem perda)', () => {
    const tx = bet('10.00');
    tx.markProcessed(undefined, at(1), brl('90.00'));
    const json = WagerTransactionProcessed.from(tx, ctx()).toJSON();
    expect(JSON.parse(JSON.stringify(json))).toEqual(json);
    expect(json.data.balanceAfter).toEqual({ amount: '90.00', currency: 'BRL' });
  });

  test('data é congelado e desacoplado do domínio', () => {
    const tx = bet('10.00');
    tx.markProcessed(undefined, at(1), brl('90.00'));
    const evt = WagerTransactionProcessed.from(tx, ctx());
    expect(Object.isFrozen(evt.data)).toBe(true);
  });

  test('Rejected e PendingReference carregam os campos específicos', () => {
    const tx = bet('10.00');
    tx.reject(FailureCode.InsufficientFunds, at(1), brl('5.00'));
    expect(String(WagerTransactionRejected.from(tx, ctx()).toJSON().data.failureCode)).toBe('INSUFFICIENT_FUNDS');

    const r = refundOf(bet('1.00'));
    r.markPendingReference(T0, FAST_RETRY);
    const p = WagerTransactionPendingReference.from(r, ctx()).toJSON();
    expect(p.data.attempts).toBe(1);
    expect(p.data.referenceExternalTransactionId).toBe(r.referenceExternalTransactionId!);
  });

  test('factories exigem o status correspondente', () => {
    expect(() => WagerTransactionProcessed.from(bet('1.00'), ctx())).toThrow(InvariantViolationError);
    expect(() => WagerTransactionRejected.from(bet('1.00'), ctx())).toThrow(InvariantViolationError);
  });
});
