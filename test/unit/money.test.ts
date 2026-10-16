import { describe, expect, test } from 'bun:test';
import { CurrencyMismatchError, InvalidMoneyError } from '../../src/shared/domain/errors';
import { Money } from '../../src/shared/domain/money';
import { brl, usd } from './fixtures/builders';

describe('Money.from — validação de entrada', () => {
  test.each([
    ['25', '25.00'],
    ['25.5', '25.50'],
    ['25.50', '25.50'],
    ['0', '0.00'],
    ['0.01', '0.01'],
    ['999999999999999999.99', '999999999999999999.99'], // limite de numeric(20,2)
  ])('aceita "%s" e normaliza para "%s"', (input, expected) => {
    expect(Money.from({ amount: input, currency: 'BRL' }).amount).toBe(expected);
  });

  test.each([
    ['', 'string vazia'],
    [' ', 'espaço'],
    [' 1.00', 'espaço à esquerda'],
    ['1.00 ', 'espaço à direita'],
    ['NaN', 'NaN'],
    ['Infinity', 'Infinity'],
    ['-Infinity', '-Infinity'],
    ['1e3', 'notação científica'],
    ['1E-2', 'notação científica'],
    ['1.234', 'mais de 2 casas (não arredonda)'],
    ['0.005', 'mais de 2 casas (não arredonda)'],
    ['-1.00', 'negativo'],
    ['-0', 'zero negativo'],
    ['+1.00', 'sinal explícito'],
    ['01.00', 'zero à esquerda'],
    ['.50', 'sem parte inteira'],
    ['5.', 'ponto sem casas'],
    ['1,00', 'vírgula decimal'],
    ['1_000.00', 'separador'],
    ['0x10', 'hexadecimal'],
    ['1000000000000000000.00', 'excede numeric(20,2)'],
  ])('rejeita "%s" (%s)', (input) => {
    expect(() => Money.from({ amount: input, currency: 'BRL' })).toThrow(InvalidMoneyError);
  });

  test('rejeita amount numérico (nunca number para dinheiro)', () => {
    expect(() => Money.from({ amount: 25 as unknown as string, currency: 'BRL' })).toThrow(InvalidMoneyError);
  });

  test.each(['brl', 'BR', 'BRLL', '', '123'])('rejeita moeda "%s"', (currency) => {
    expect(() => Money.from({ amount: '1.00', currency })).toThrow(InvalidMoneyError);
  });
});

describe('Money — aritmética exata e imutável', () => {
  test('0.10 + 0.20 === 0.30 (sem erro de ponto flutuante)', () => {
    expect(brl('0.10').add(brl('0.20')).equals(brl('0.30'))).toBe(true);
  });

  test('soma de 1000 centavos é exata', () => {
    let total = Money.zero('BRL');
    for (let i = 0; i < 1000; i++) total = total.add(brl('0.01'));
    expect(total.amount).toBe('10.00');
  });

  test('subtract pode produzir negativo; negate inverte o sinal', () => {
    const r = brl('20.00').subtract(brl('80.00'));
    expect(r.amount).toBe('-60.00');
    expect(r.isNegative()).toBe(true);
    expect(r.negate().amount).toBe('60.00');
  });

  test('negate de zero serializa como "0.00" (sem -0)', () => {
    expect(Money.zero('BRL').negate().amount).toBe('0.00');
  });

  test('operações retornam novas instâncias e não mutam a original', () => {
    const a = brl('10.00');
    const b = a.add(brl('5.00'));
    expect(a.amount).toBe('10.00');
    expect(b).not.toBe(a);
    expect(Object.isFrozen(a)).toBe(true);
  });

  test('predicados', () => {
    expect(Money.zero('BRL').isZero()).toBe(true);
    expect(brl('0.01').isPositive()).toBe(true);
    expect(brl('1.00').isLessThan(brl('1.01'))).toBe(true);
    expect(brl('1.01').isGreaterThan(brl('1.00'))).toBe(true);
    expect(brl('1.00').equals(brl('1'))).toBe(true);
  });

  test('não converte para number implicitamente', () => {
    expect(() => +brl('1.00')).toThrow(InvalidMoneyError);
  });
});

describe('Money — conflito de moeda', () => {
  test.each([
    ['add', (a: Money, b: Money) => a.add(b)],
    ['subtract', (a: Money, b: Money) => a.subtract(b)],
    ['isLessThan', (a: Money, b: Money) => a.isLessThan(b)],
    ['isGreaterThan', (a: Money, b: Money) => a.isGreaterThan(b)],
  ] as const)('%s entre BRL e USD lança CurrencyMismatchError', (_name, op) => {
    expect(() => op(brl('1.00'), usd('1.00'))).toThrow(CurrencyMismatchError);
  });

  test('equals entre moedas diferentes é false, não lança', () => {
    expect(brl('1.00').equals(usd('1.00'))).toBe(false);
  });
});

describe('Money — serialização', () => {
  test('toJSON usa string decimal com escala 2', () => {
    expect(JSON.stringify({ money: brl('25') })).toBe('{"money":{"amount":"25.00","currency":"BRL"}}');
    expect(brl('25.5').toString()).toBe('25.50 BRL');
  });

  test('round-trip from(toJSON()) preserva valor', () => {
    const m = brl('1234.56');
    expect(Money.from(m.toJSON()).equals(m)).toBe(true);
  });
});
