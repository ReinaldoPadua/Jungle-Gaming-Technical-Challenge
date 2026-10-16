import { describe, expect, test } from 'bun:test';
import { InvalidArgumentError, InvariantViolationError } from '../../src/shared/domain/errors';
import { LedgerDirection } from '../../src/modules/wallet/domain/ledger-direction';
import { FailureCode } from '../../src/modules/wagering/domain/failure-code';
import { WagerTransaction } from '../../src/modules/wagering/domain/wager-transaction';
import { InvalidTransactionStateError } from '../../src/modules/wagering/domain/wager-transaction.errors';
import { WagerTransactionKind as Kind } from '../../src/modules/wagering/domain/wager-transaction-kind';
import { WagerTransactionStatus as Status } from '../../src/modules/wagering/domain/wager-transaction-status';
import { at, bet, brl, FAST_RETRY, loss, refundOf, rollbackOf, T0, wager, win } from './fixtures/builders';

describe('WagerTransaction.create', () => {
  test('nasce PENDING, sem attempts', () => {
    const tx = bet('25.00');
    expect(tx.status).toBe(Status.Pending);
    expect(tx.attempts).toBe(0);
    expect(tx.isTerminal()).toBe(false);
  });

  test('OPENING não pode ser submetido externamente', () => {
    expect(() => wager(Kind.Opening, '10.00')).toThrow(InvalidArgumentError);
  });

  test('providerId "internal" é reservado', () => {
    expect(() => bet('1.00', { providerId: 'internal' })).toThrow(InvalidArgumentError);
  });

  test.each([Kind.Refund, Kind.Rollback])('%s exige referenceExternalTransactionId', (kind) => {
    expect(() => wager(kind, '10.00')).toThrow(InvalidArgumentError);
  });

  test('BET não pode ter referência', () => {
    expect(() => bet('10.00', { referenceExternalTransactionId: 'x' })).toThrow(InvalidArgumentError);
  });

  test('WIN e LOSS podem ter referência opcional', () => {
    expect(win('10.00', { referenceExternalTransactionId: 'b' }).hasReference()).toBe(true);
    expect(loss('0.00').hasReference()).toBe(false);
  });

  test('auto-referência é rejeitada', () => {
    expect(() =>
      wager(Kind.Refund, '1.00', { externalTransactionId: 'same', referenceExternalTransactionId: 'same' }),
    ).toThrow(InvalidArgumentError);
  });

  test.each([Kind.Bet, Kind.Win])('%s com valor zero é rejeitado', (kind) => {
    expect(() => wager(kind, '0.00')).toThrow(InvalidArgumentError);
  });

  test('LOSS aceita valor zero', () => {
    expect(loss('0.00').money.isZero()).toBe(true);
  });

  test('campos obrigatórios vazios são rejeitados', () => {
    expect(() => bet('1.00', { roundId: '' })).toThrow(InvalidArgumentError);
  });
});

describe('WagerTransaction — máquina de estados', () => {
  test('PENDING → PROCESSED registra referência, saldo resultante e processedAt', () => {
    const tx = bet('10.00');
    tx.markProcessed(undefined, at(5), brl('90.00'));
    expect(tx.status).toBe(Status.Processed);
    expect(tx.resultBalance!.amount).toBe('90.00');
    expect(tx.processedAt).toEqual(at(5));
    expect(tx.isTerminal()).toBe(true);
  });

  test('PENDING → PENDING_REFERENCE agenda com backoff exponencial; reagendar incrementa attempts', () => {
    const tx = refundOf(bet('10.00'));
    tx.markPendingReference(T0, FAST_RETRY);
    expect(tx.status).toBe(Status.PendingReference);
    expect(tx.attempts).toBe(1);
    expect(tx.nextAttemptAt).toEqual(at(100));
    tx.markPendingReference(at(100), FAST_RETRY);
    expect(tx.attempts).toBe(2);
    expect(tx.nextAttemptAt).toEqual(at(100 + 200));
  });

  test('backoff respeita maxDelay', () => {
    const tx = refundOf(bet('10.00'));
    for (let i = 0; i < 8; i++) tx.markPendingReference(T0, { ...FAST_RETRY, maxAttempts: 99 });
    expect(tx.nextAttemptAt!.getTime() - T0.getTime()).toBe(FAST_RETRY.maxDelayMs);
  });

  test('espera esgota por tentativas ou por TTL', () => {
    const tx = refundOf(bet('10.00'));
    expect(tx.isReferenceWaitExhausted(T0, FAST_RETRY)).toBe(false);
    for (let i = 0; i < FAST_RETRY.maxAttempts; i++) tx.markPendingReference(T0, FAST_RETRY);
    expect(tx.isReferenceWaitExhausted(T0, FAST_RETRY)).toBe(true);
    const fresh = refundOf(bet('10.00'));
    expect(fresh.isReferenceWaitExhausted(at(FAST_RETRY.ttlMs), FAST_RETRY)).toBe(true);
  });

  test('PENDING_REFERENCE → PROCESSED limpa nextAttemptAt', () => {
    const tx = refundOf(bet('10.00'));
    tx.markPendingReference(T0, FAST_RETRY);
    tx.markProcessed('ref-id', at(1), brl('10.00'));
    expect(tx.nextAttemptAt).toBeUndefined();
    expect(tx.referenceTransactionId).toBe('ref-id');
  });

  test('REFUND/ROLLBACK não podem ser processados sem referência resolvida', () => {
    expect(() => refundOf(bet('1.00')).markProcessed(undefined, T0, brl('1.00'))).toThrow(InvariantViolationError);
  });

  test('reject guarda failureCode e saldo observado', () => {
    const tx = bet('10.00');
    tx.reject(FailureCode.InsufficientFunds, T0, brl('5.00'));
    expect(tx.status).toBe(Status.Rejected);
    expect(tx.failureCode).toBe(FailureCode.InsufficientFunds);
    expect(tx.resultBalance!.amount).toBe('5.00');
  });

  test('reject não aceita código de infraestrutura; fail sim', () => {
    expect(() => bet('1.00').reject(FailureCode.InfraPermanentFailure, T0)).toThrow(InvariantViolationError);
    const tx = bet('1.00');
    tx.fail(FailureCode.InfraPermanentFailure, T0);
    expect(tx.status).toBe(Status.Failed);
  });

  const terminalize: Record<string, (tx: WagerTransaction) => void> = {
    PROCESSED: (tx) => tx.markProcessed(undefined, T0, brl('0.00')),
    REJECTED: (tx) => tx.reject(FailureCode.InsufficientFunds, T0),
    FAILED: (tx) => tx.fail(FailureCode.InfraPermanentFailure, T0),
  };
  const transitions: Record<string, (tx: WagerTransaction) => void> = {
    markProcessed: (tx) => tx.markProcessed(undefined, T0, brl('0.00')),
    markPendingReference: (tx) => tx.markPendingReference(T0, FAST_RETRY),
    reject: (tx) => tx.reject(FailureCode.InsufficientFunds, T0),
    fail: (tx) => tx.fail(FailureCode.InfraPermanentFailure, T0),
  };
  for (const [terminal, toTerminal] of Object.entries(terminalize)) {
    for (const [name, transition] of Object.entries(transitions)) {
      test(`${terminal} é terminal: ${name} lança InvalidTransactionStateError`, () => {
        const tx = bet('1.00');
        toTerminal(tx);
        expect(() => transition(tx)).toThrow(InvalidTransactionStateError);
      });
    }
  }
});

describe('WagerTransaction — consultas de domínio', () => {
  test('affectsBalance é false somente para LOSS', () => {
    expect(loss('1.00').affectsBalance()).toBe(false);
    for (const tx of [bet('1.00'), win('1.00'), refundOf(bet('1.00')), rollbackOf(bet('1.00'))]) {
      expect(tx.affectsBalance()).toBe(true);
    }
  });

  test('requiresReference somente para REFUND e ROLLBACK', () => {
    expect(bet('1.00').requiresReference()).toBe(false);
    expect(win('1.00').requiresReference()).toBe(false);
    expect(refundOf(bet('1.00')).requiresReference()).toBe(true);
    expect(rollbackOf(bet('1.00')).requiresReference()).toBe(true);
  });

  test('ledgerDirectionFor', () => {
    const b = bet('10.00');
    const w = win('10.00');
    const r = refundOf(b);
    expect(b.ledgerDirectionFor()).toBe(LedgerDirection.Debit);
    expect(w.ledgerDirectionFor()).toBe(LedgerDirection.Credit);
    expect(r.ledgerDirectionFor(b)).toBe(LedgerDirection.Credit);
    expect(rollbackOf(b).ledgerDirectionFor(b)).toBe(LedgerDirection.Credit);
    expect(rollbackOf(w).ledgerDirectionFor(w)).toBe(LedgerDirection.Debit);
    expect(rollbackOf(r).ledgerDirectionFor(r)).toBe(LedgerDirection.Debit);
    expect(() => rollbackOf(b).ledgerDirectionFor()).toThrow(InvariantViolationError);
    expect(() => loss('1.00').ledgerDirectionFor()).toThrow(InvariantViolationError);
  });

  test('matchesPayload: mesma key com hash diferente é conflito', () => {
    const tx = bet('1.00', { payloadHash: 'abc' });
    expect(tx.matchesPayload('abc')).toBe(true);
    expect(tx.matchesPayload('abd')).toBe(false);
  });

  test('createOpening nasce PROCESSED com provider interno', () => {
    const tx = WagerTransaction.createOpening({ id: 'o', walletId: 'w', playerId: 'p', money: brl('1000.00'), at: T0 });
    expect(tx.kind).toBe(Kind.Opening);
    expect(tx.status).toBe(Status.Processed);
    expect(tx.providerId).toBe('internal');
    expect(tx.ledgerDirectionFor()).toBe(LedgerDirection.Credit);
  });

  test('rehydrate(toState()) preserva estado sem revalidar transições', () => {
    const tx = refundOf(bet('1.00'));
    tx.markPendingReference(T0, FAST_RETRY);
    const copy = WagerTransaction.rehydrate(tx.toState());
    expect(copy.status).toBe(Status.PendingReference);
    expect(copy.attempts).toBe(1);
    expect(copy.nextAttemptAt).toEqual(tx.nextAttemptAt);
  });
});
