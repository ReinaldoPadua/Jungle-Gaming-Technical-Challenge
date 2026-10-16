import { InvariantViolationError } from '../../../shared/domain/errors';
import { Money } from '../../../shared/domain/money';
import { LedgerDirection } from './ledger-direction';

export interface LedgerEntryState {
  id: string;
  walletId: string;
  transactionId: string;
  direction: LedgerDirection;
  money: Money;
  balanceBefore: Money;
  balanceAfter: Money;
  /** Posição do lançamento na wallet; igual à `version` da wallet após aplicá-lo. */
  sequence: number;
  createdAt: Date;
}

export type CreateLedgerEntryProps = LedgerEntryState;

/**
 * Lançamento imutável do ledger. Sem setters, sem transições e congelado na
 * construção: a imutabilidade é estrutural. No banco, um trigger impede
 * UPDATE/DELETE (fase 2).
 */
export class WalletLedgerEntry {
  private constructor(
    public readonly id: string,
    public readonly walletId: string,
    public readonly transactionId: string,
    public readonly direction: LedgerDirection,
    public readonly money: Money,
    public readonly balanceBefore: Money,
    public readonly balanceAfter: Money,
    public readonly sequence: number,
    public readonly createdAt: Date,
  ) {
    Object.freeze(this);
  }

  /** Valida a aritmética e as invariantes do lançamento. */
  static create(props: CreateLedgerEntryProps): WalletLedgerEntry {
    const entry = WalletLedgerEntry.build(props);
    if (!entry.money.isPositive()) throw new InvariantViolationError('ledger entry amount must be positive');
    if (entry.balanceBefore.isNegative() || entry.balanceAfter.isNegative()) {
      throw new InvariantViolationError('ledger entry cannot produce a negative balance');
    }
    if (!Number.isSafeInteger(entry.sequence) || entry.sequence < 1) {
      throw new InvariantViolationError('ledger entry sequence must be a positive integer');
    }
    // isBalanced() também valida que as três moedas coincidem (subtract/add lançam).
    if (!entry.isBalanced()) {
      throw new InvariantViolationError(
        `unbalanced ledger entry: ${entry.balanceBefore} ${entry.direction} ${entry.money} != ${entry.balanceAfter}`,
      );
    }
    return entry;
  }

  /** Reconstrução a partir da persistência — não revalida (o schema já garante). */
  static rehydrate(state: LedgerEntryState): WalletLedgerEntry {
    return WalletLedgerEntry.build(state);
  }

  /** balanceBefore ± money === balanceAfter */
  isBalanced(): boolean {
    const expected =
      this.direction === LedgerDirection.Credit
        ? this.balanceBefore.add(this.money)
        : this.balanceBefore.subtract(this.money);
    return expected.equals(this.balanceAfter);
  }

  /** Efeito com sinal sobre o saldo (+ crédito, − débito). */
  signedAmount(): Money {
    return this.direction === LedgerDirection.Credit ? this.money : this.money.negate();
  }

  private static build(s: LedgerEntryState): WalletLedgerEntry {
    return new WalletLedgerEntry(
      s.id,
      s.walletId,
      s.transactionId,
      s.direction,
      s.money,
      s.balanceBefore,
      s.balanceAfter,
      s.sequence,
      new Date(s.createdAt.getTime()),
    );
  }
}
