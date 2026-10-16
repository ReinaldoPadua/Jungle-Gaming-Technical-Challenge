import BigLib from 'big.js';
import { CurrencyMismatchError, InvalidMoneyError } from './errors';

/**
 * Construtor isolado do big.js em modo estrito: rejeita `number` como entrada
 * e proíbe conversão implícita para number (valueOf lança). Nenhuma operação
 * do Money divide ou multiplica, então nunca há arredondamento.
 */
const Decimal = BigLib();
Decimal.strict = true;
type Decimal = BigLib.Big;

export const MONEY_SCALE = 2;
/** numeric(20,2) no banco → até 18 dígitos inteiros. */
export const MONEY_MAX_INTEGER_DIGITS = 18;

/** DTO de contrato: amount é sempre string decimal. */
export interface MoneyProps {
  amount: string;
  currency: string;
}

const AMOUNT_PATTERN = new RegExp(`^(0|[1-9]\\d{0,${MONEY_MAX_INTEGER_DIGITS - 1}})(\\.\\d{1,${MONEY_SCALE}})?$`);
const CURRENCY_PATTERN = /^[A-Z]{3}$/;
const ZERO_AMOUNT = '0.00';

export class Money {
  private constructor(
    private readonly value: Decimal,
    public readonly currency: string,
  ) {
    Object.freeze(this);
  }

  /**
   * Fábrica para contratos de entrada e reidratação.
   * Aceita somente decimal não-negativo com até 2 casas, sem sinal, sem
   * notação científica, sem zeros à esquerda e sem espaços. Normaliza a escala:
   * "25" e "25.5" viram "25.00" e "25.50". Mais de 2 casas é rejeitado (nunca arredondado).
   */
  static from(props: MoneyProps): Money {
    if (props === null || typeof props !== 'object') throw new InvalidMoneyError('money must be an object');
    const { amount, currency } = props;
    Money.assertCurrency(currency);
    if (typeof amount !== 'string') throw new InvalidMoneyError('amount must be a decimal string');
    if (!AMOUNT_PATTERN.test(amount)) {
      throw new InvalidMoneyError(
        `invalid amount "${amount}": expected a non-negative decimal string with at most ${MONEY_SCALE} decimal places`,
      );
    }
    return new Money(new Decimal(amount), currency);
  }

  static zero(currency: string): Money {
    Money.assertCurrency(currency);
    return new Money(new Decimal('0'), currency);
  }

  add(other: Money): Money {
    this.assertSameCurrency(other);
    return new Money(this.value.plus(other.value), this.currency);
  }

  subtract(other: Money): Money {
    this.assertSameCurrency(other);
    return new Money(this.value.minus(other.value), this.currency);
  }

  negate(): Money {
    return new Money(this.value.times(new Decimal('-1')), this.currency);
  }

  isZero(): boolean {
    return this.value.eq(new Decimal('0'));
  }

  isPositive(): boolean {
    return this.value.gt(new Decimal('0'));
  }

  isNegative(): boolean {
    return this.value.lt(new Decimal('0'));
  }

  isLessThan(other: Money): boolean {
    this.assertSameCurrency(other);
    return this.value.lt(other.value);
  }

  isGreaterThan(other: Money): boolean {
    this.assertSameCurrency(other);
    return this.value.gt(other.value);
  }

  /** Igualdade de valor e moeda. Moedas diferentes → false (não lança). */
  equals(other: Money): boolean {
    return this.currency === other.currency && this.value.eq(other.value);
  }

  /** Valor decimal com escala fixa de 2 casas, ex.: "25.00", "-80.00". */
  get amount(): string {
    // big.js preserva o sinal de zero (-0); normaliza para "0.00".
    return this.isZero() ? ZERO_AMOUNT : this.value.toFixed(MONEY_SCALE);
  }

  toJSON(): MoneyProps {
    return { amount: this.amount, currency: this.currency };
  }

  toString(): string {
    return `${this.amount} ${this.currency}`;
  }

  /** Impede uso acidental em aritmética/comparação nativa (`money > 10`, `+money`). */
  valueOf(): never {
    throw new InvalidMoneyError('Money cannot be converted to a primitive number');
  }

  private assertSameCurrency(other: Money): void {
    if (other.currency !== this.currency) throw new CurrencyMismatchError(this.currency, other.currency);
  }

  private static assertCurrency(currency: unknown): asserts currency is string {
    if (typeof currency !== 'string' || !CURRENCY_PATTERN.test(currency)) {
      throw new InvalidMoneyError(`invalid currency "${String(currency)}": expected ISO-4217 alpha code`);
    }
  }
}
