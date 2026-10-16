import { CurrencyMismatchError, InvalidArgumentError, InvariantViolationError } from '../../../shared/domain/errors';
import { Money } from '../../../shared/domain/money';
import { LedgerDirection } from './ledger-direction';
import { WalletLedgerEntry } from './wallet-ledger-entry';
import { InsufficientFundsError } from './wallet.errors';

export interface WalletState {
  id: string;
  playerId: string;
  currency: string;
  balance: Money;
  version: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface OpenWalletProps {
  id: string;
  playerId: string;
  initialBalance: Money;
  /** Obrigatório quando initialBalance > 0: id da transação interna OPENING. */
  openingTransactionId?: string;
  /** Obrigatório quando initialBalance > 0: id do lançamento de abertura. */
  openingEntryId?: string;
  at: Date;
}

export interface Movement {
  entryId: string;
  transactionId: string;
  money: Money;
  at: Date;
}

export interface OpenedWallet {
  wallet: Wallet;
  /** Lançamento CREDIT de abertura, presente somente se initialBalance > 0. */
  openingEntry: WalletLedgerEntry | undefined;
}

/**
 * Aggregate root. Saldo e ledger mudam juntos: `debit`/`credit` são a única
 * forma de alterar o saldo e sempre devolvem o lançamento correspondente,
 * então é impossível mover saldo sem produzir ledger (e vice-versa).
 *
 * `version` começa em 1 e incrementa somente quando o saldo muda; o
 * lançamento recebe `sequence = version` resultante, o que dá ao ledger uma
 * ordem total por wallet (UNIQUE(wallet_id, sequence) no banco).
 */
export class Wallet {
  private constructor(
    public readonly id: string,
    public readonly playerId: string,
    public readonly currency: string,
    private _balance: Money,
    private _version: number,
    public readonly createdAt: Date,
    private _updatedAt: Date,
  ) {}

  static open(props: OpenWalletProps): OpenedWallet {
    const { id, playerId, initialBalance, at } = props;
    if (!id) throw new InvalidArgumentError('INVALID_WALLET_ID', 'wallet id is required');
    if (!playerId) throw new InvalidArgumentError('INVALID_PLAYER_ID', 'playerId is required');
    if (initialBalance.isNegative()) {
      throw new InvalidArgumentError('NEGATIVE_INITIAL_BALANCE', 'initial balance cannot be negative');
    }

    const wallet = new Wallet(id, playerId, initialBalance.currency, Money.zero(initialBalance.currency), 1, at, at);
    if (initialBalance.isZero()) return { wallet, openingEntry: undefined };

    if (!props.openingTransactionId || !props.openingEntryId) {
      throw new InvariantViolationError('opening transaction and entry ids are required for a positive initial balance');
    }
    // A abertura é a primeira movimentação mas não incrementa version: a wallet
    // nasce com version 1 já contendo o saldo inicial (sequence 1 no ledger).
    const openingEntry = wallet.apply(
      LedgerDirection.Credit,
      { entryId: props.openingEntryId, transactionId: props.openingTransactionId, money: initialBalance, at },
      { bumpVersion: false },
    );
    return { wallet, openingEntry };
  }

  /** Reconstrução a partir da persistência — não revalida transições. */
  static rehydrate(state: WalletState): Wallet {
    return new Wallet(
      state.id,
      state.playerId,
      state.currency,
      state.balance,
      state.version,
      new Date(state.createdAt.getTime()),
      new Date(state.updatedAt.getTime()),
    );
  }

  get balance(): Money {
    return this._balance;
  }

  get version(): number {
    return this._version;
  }

  get updatedAt(): Date {
    return this._updatedAt;
  }

  /** @throws InsufficientFundsError se o saldo ficaria negativo */
  debit(movement: Movement): WalletLedgerEntry {
    return this.apply(LedgerDirection.Debit, movement);
  }

  credit(movement: Movement): WalletLedgerEntry {
    return this.apply(LedgerDirection.Credit, movement);
  }

  /** Movimentação genérica pela direção (usada por ROLLBACK, cuja direção depende da referência). */
  move(direction: LedgerDirection, movement: Movement): WalletLedgerEntry {
    return this.apply(direction, movement);
  }

  private apply(
    direction: LedgerDirection,
    movement: Movement,
    opts: { bumpVersion: boolean } = { bumpVersion: true },
  ): WalletLedgerEntry {
    const { money } = movement;
    this.assertSameCurrency(money);
    if (!money.isPositive()) {
      throw new InvalidArgumentError('NON_POSITIVE_AMOUNT', 'movement amount must be greater than zero');
    }

    const before = this._balance;
    const after = direction === LedgerDirection.Credit ? before.add(money) : before.subtract(money);
    if (after.isNegative()) throw new InsufficientFundsError(this.id, before, money);

    const nextVersion = opts.bumpVersion ? this._version + 1 : this._version;
    // Cria o lançamento ANTES de mutar: se a factory rejeitar, o agregado fica intacto.
    const entry = WalletLedgerEntry.create({
      id: movement.entryId,
      walletId: this.id,
      transactionId: movement.transactionId,
      direction,
      money,
      balanceBefore: before,
      balanceAfter: after,
      sequence: nextVersion,
      createdAt: movement.at,
    });

    this._balance = after;
    this._version = nextVersion;
    this._updatedAt = movement.at;
    return entry;
  }

  canAfford(money: Money): boolean {
    this.assertSameCurrency(money);
    return !this._balance.isLessThan(money);
  }

  toState(): WalletState {
    return {
      id: this.id,
      playerId: this.playerId,
      currency: this.currency,
      balance: this._balance,
      version: this._version,
      createdAt: this.createdAt,
      updatedAt: this._updatedAt,
    };
  }

  private assertSameCurrency(money: Money): void {
    if (money.currency !== this.currency) throw new CurrencyMismatchError(this.currency, money.currency);
  }
}
