import { InvalidArgumentError, InvariantViolationError } from '../../../shared/domain/errors';
import type { Money } from '../../../shared/domain/money';
import { LedgerDirection, oppositeDirection } from '../../wallet/domain/ledger-direction';
import { FailureCode } from './failure-code';
import { type ReferenceRetryPolicy, referenceRetryDelayMs } from './reference-retry-policy';
import { InvalidTransactionStateError } from './wager-transaction.errors';
import { EXTERNAL_KINDS, WagerTransactionKind } from './wager-transaction-kind';
import { TERMINAL_STATUSES, WagerTransactionStatus } from './wager-transaction-status';

export interface CreateWagerTransactionProps {
  id: string;
  providerId: string;
  externalTransactionId: string;
  idempotencyKey: string;
  payloadHash: string;
  walletId: string;
  playerId: string;
  roundId: string;
  gameId: string;
  kind: WagerTransactionKind;
  money: Money;
  /** id no provedor — não o id interno */
  referenceExternalTransactionId?: string;
  createdAt: Date;
}

export interface WagerTransactionState extends CreateWagerTransactionProps {
  status: WagerTransactionStatus;
  referenceTransactionId?: string;
  failureCode?: FailureCode;
  /** saldo observado no momento da decisão — devolvido em replays */
  resultBalance?: Money;
  attempts: number;
  nextAttemptAt?: Date;
  processedAt?: Date;
  updatedAt: Date;
}

/** Provider de onde vêm as transações internas (OPENING). */
export const INTERNAL_PROVIDER_ID = 'internal';

/**
 * Máquina de estados:
 *
 *   PENDING ──────────────► PROCESSED | REJECTED | FAILED   (terminais)
 *      │                         ▲
 *      ▼                         │
 *   PENDING_REFERENCE ───────────┘
 *      ▲  │  (reagendamento: attempts++, nextAttemptAt)
 *      └──┘
 *
 * Qualquer transição a partir de um estado terminal lança InvalidTransactionStateError.
 */
export class WagerTransaction {
  private constructor(
    public readonly id: string,
    public readonly providerId: string,
    public readonly externalTransactionId: string,
    public readonly idempotencyKey: string,
    public readonly payloadHash: string,
    public readonly walletId: string,
    public readonly playerId: string,
    public readonly roundId: string,
    public readonly gameId: string,
    public readonly kind: WagerTransactionKind,
    public readonly money: Money,
    public readonly referenceExternalTransactionId: string | undefined,
    public readonly createdAt: Date,
    private _status: WagerTransactionStatus,
    private _attempts: number,
    private _updatedAt: Date,
    private _referenceTransactionId?: string,
    private _failureCode?: FailureCode,
    private _resultBalance?: Money,
    private _nextAttemptAt?: Date,
    private _processedAt?: Date,
  ) {}

  /** Transação submetida por provedor. Nasce em PENDING e valida a referência por kind. */
  static create(props: CreateWagerTransactionProps): WagerTransaction {
    if (!EXTERNAL_KINDS.has(props.kind)) {
      throw new InvalidArgumentError('KIND_NOT_ALLOWED', `kind ${props.kind} cannot be submitted externally`);
    }
    if (props.providerId === INTERNAL_PROVIDER_ID) {
      throw new InvalidArgumentError('RESERVED_PROVIDER_ID', `providerId "${INTERNAL_PROVIDER_ID}" is reserved`);
    }
    return WagerTransaction.newPending(props);
  }

  /** Transação interna de abertura da wallet. Já nasce PROCESSED. */
  static createOpening(props: {
    id: string;
    walletId: string;
    playerId: string;
    money: Money;
    at: Date;
  }): WagerTransaction {
    const tx = WagerTransaction.newPending({
      id: props.id,
      providerId: INTERNAL_PROVIDER_ID,
      externalTransactionId: `opening:${props.walletId}`,
      idempotencyKey: `${INTERNAL_PROVIDER_ID}:opening:${props.walletId}`,
      payloadHash: 'internal',
      walletId: props.walletId,
      playerId: props.playerId,
      roundId: 'opening',
      gameId: 'internal',
      kind: WagerTransactionKind.Opening,
      money: props.money,
      createdAt: props.at,
    });
    tx.markProcessed(undefined, props.at, props.money);
    return tx;
  }

  /** Reconstrução a partir da persistência — não revalida transições. */
  static rehydrate(s: WagerTransactionState): WagerTransaction {
    return new WagerTransaction(
      s.id,
      s.providerId,
      s.externalTransactionId,
      s.idempotencyKey,
      s.payloadHash,
      s.walletId,
      s.playerId,
      s.roundId,
      s.gameId,
      s.kind,
      s.money,
      s.referenceExternalTransactionId,
      s.createdAt,
      s.status,
      s.attempts,
      s.updatedAt,
      s.referenceTransactionId,
      s.failureCode,
      s.resultBalance,
      s.nextAttemptAt,
      s.processedAt,
    );
  }

  private static newPending(p: CreateWagerTransactionProps): WagerTransaction {
    for (const field of ['id', 'providerId', 'externalTransactionId', 'idempotencyKey', 'payloadHash', 'walletId', 'playerId', 'roundId', 'gameId'] as const) {
      if (typeof p[field] !== 'string' || p[field].length === 0) {
        throw new InvalidArgumentError('MISSING_FIELD', `${field} is required`);
      }
    }
    const ref = p.referenceExternalTransactionId;
    if (ref !== undefined && ref.length === 0) {
      throw new InvalidArgumentError('MISSING_FIELD', 'referenceExternalTransactionId cannot be empty');
    }

    switch (p.kind) {
      case WagerTransactionKind.Refund:
      case WagerTransactionKind.Rollback:
        if (ref === undefined) {
          throw new InvalidArgumentError('REFERENCE_REQUIRED', `${p.kind} requires referenceExternalTransactionId`);
        }
        break;
      case WagerTransactionKind.Bet:
      case WagerTransactionKind.Opening:
        if (ref !== undefined) {
          throw new InvalidArgumentError('REFERENCE_NOT_ALLOWED', `${p.kind} cannot reference another transaction`);
        }
        break;
      // WIN e LOSS podem (opcionalmente) referenciar a BET da rodada.
    }
    if (ref !== undefined && ref === p.externalTransactionId) {
      throw new InvalidArgumentError('SELF_REFERENCE', 'a transaction cannot reference itself');
    }

    // LOSS registra o resultado e pode ter valor 0.00; as demais movem saldo e exigem > 0.
    const zeroAllowed = p.kind === WagerTransactionKind.Loss;
    if (p.money.isNegative() || (!zeroAllowed && p.money.isZero())) {
      throw new InvalidArgumentError('NON_POSITIVE_AMOUNT', `${p.kind} amount must be greater than zero`);
    }

    return new WagerTransaction(
      p.id,
      p.providerId,
      p.externalTransactionId,
      p.idempotencyKey,
      p.payloadHash,
      p.walletId,
      p.playerId,
      p.roundId,
      p.gameId,
      p.kind,
      p.money,
      ref,
      p.createdAt,
      WagerTransactionStatus.Pending,
      0,
      p.createdAt,
    );
  }

  // ---------------------------------------------------------------- getters

  get status(): WagerTransactionStatus {
    return this._status;
  }
  get referenceTransactionId(): string | undefined {
    return this._referenceTransactionId;
  }
  get failureCode(): FailureCode | undefined {
    return this._failureCode;
  }
  get resultBalance(): Money | undefined {
    return this._resultBalance;
  }
  get attempts(): number {
    return this._attempts;
  }
  get nextAttemptAt(): Date | undefined {
    return this._nextAttemptAt;
  }
  get processedAt(): Date | undefined {
    return this._processedAt;
  }
  get updatedAt(): Date {
    return this._updatedAt;
  }

  // ------------------------------------------------------------ transições

  /**
   * @param referenceTransactionId id interno da referência (obrigatório para REFUND/ROLLBACK)
   * @param balanceAfter saldo da wallet após aplicar — devolvido em replays
   */
  markProcessed(referenceTransactionId: string | undefined, at: Date, balanceAfter: Money): void {
    this.assertNotTerminal('markProcessed');
    if (this.requiresReference() && !referenceTransactionId) {
      throw new InvariantViolationError(`${this.kind} cannot be processed without a resolved reference`);
    }
    this._status = WagerTransactionStatus.Processed;
    this._referenceTransactionId = referenceTransactionId;
    this._resultBalance = balanceAfter;
    this._processedAt = at;
    this._nextAttemptAt = undefined;
    this._updatedAt = at;
  }

  /**
   * Coloca (ou mantém) a transação aguardando a referência e agenda a próxima
   * tentativa com backoff exponencial. Chamado na primeira chegada (PENDING)
   * e a cada reprocessamento sem sucesso (PENDING_REFERENCE).
   */
  markPendingReference(now: Date, policy: ReferenceRetryPolicy): void {
    this.assertNotTerminal('markPendingReference');
    this._attempts += 1;
    this._status = WagerTransactionStatus.PendingReference;
    this._nextAttemptAt = new Date(now.getTime() + referenceRetryDelayMs(policy, this._attempts));
    this._updatedAt = now;
  }

  /** true quando a espera pela referência estourou tentativas ou TTL. */
  isReferenceWaitExhausted(now: Date, policy: ReferenceRetryPolicy): boolean {
    return this._attempts >= policy.maxAttempts || now.getTime() - this.createdAt.getTime() >= policy.ttlMs;
  }

  /**
   * @param observedBalance saldo da wallet no momento da rejeição (quando houver wallet)
   */
  reject(code: FailureCode, at: Date, observedBalance?: Money): void {
    this.assertNotTerminal('reject');
    if (code === FailureCode.InfraPermanentFailure) {
      throw new InvariantViolationError('infrastructure failures must use fail(), not reject()');
    }
    this._status = WagerTransactionStatus.Rejected;
    this._failureCode = code;
    this._resultBalance = observedBalance;
    this._nextAttemptAt = undefined;
    this._updatedAt = at;
  }

  fail(code: FailureCode, at: Date): void {
    this.assertNotTerminal('fail');
    this._status = WagerTransactionStatus.Failed;
    this._failureCode = code;
    this._nextAttemptAt = undefined;
    this._updatedAt = at;
  }

  // ------------------------------------------------------ consultas de domínio

  isTerminal(): boolean {
    return TERMINAL_STATUSES.has(this._status);
  }

  /** false para LOSS — único kind que não move saldo. */
  affectsBalance(): boolean {
    return this.kind !== WagerTransactionKind.Loss;
  }

  requiresReference(): boolean {
    return this.kind === WagerTransactionKind.Refund || this.kind === WagerTransactionKind.Rollback;
  }

  hasReference(): boolean {
    return this.referenceExternalTransactionId !== undefined;
  }

  isReversal(): boolean {
    return this.requiresReference();
  }

  /** Mesma idempotency key com hash diferente é conflito, não replay. */
  matchesPayload(payloadHash: string): boolean {
    return this.payloadHash === payloadHash;
  }

  /**
   * Direção do lançamento que esta transação produz.
   * ROLLBACK inverte a direção da referência (BET→CREDIT, WIN/REFUND→DEBIT).
   */
  ledgerDirectionFor(reference?: WagerTransaction): LedgerDirection {
    switch (this.kind) {
      case WagerTransactionKind.Bet:
        return LedgerDirection.Debit;
      case WagerTransactionKind.Win:
      case WagerTransactionKind.Refund:
      case WagerTransactionKind.Opening:
        return LedgerDirection.Credit;
      case WagerTransactionKind.Rollback:
        if (!reference) throw new InvariantViolationError('ROLLBACK direction depends on its reference');
        return oppositeDirection(reference.ledgerDirectionFor());
      case WagerTransactionKind.Loss:
        throw new InvariantViolationError('LOSS does not affect balance and has no ledger direction');
    }
  }

  toState(): WagerTransactionState {
    return {
      id: this.id,
      providerId: this.providerId,
      externalTransactionId: this.externalTransactionId,
      idempotencyKey: this.idempotencyKey,
      payloadHash: this.payloadHash,
      walletId: this.walletId,
      playerId: this.playerId,
      roundId: this.roundId,
      gameId: this.gameId,
      kind: this.kind,
      money: this.money,
      referenceExternalTransactionId: this.referenceExternalTransactionId,
      createdAt: this.createdAt,
      status: this._status,
      referenceTransactionId: this._referenceTransactionId,
      failureCode: this._failureCode,
      resultBalance: this._resultBalance,
      attempts: this._attempts,
      nextAttemptAt: this._nextAttemptAt,
      processedAt: this._processedAt,
      updatedAt: this._updatedAt,
    };
  }

  private assertNotTerminal(attempted: string): void {
    if (this.isTerminal()) throw new InvalidTransactionStateError(this.id, this._status, attempted);
  }
}
