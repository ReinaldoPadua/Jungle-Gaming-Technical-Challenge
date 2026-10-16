import { describe, expect, test } from 'bun:test';
import { canonicalJson } from '../../src/shared/canonical-json';
import { computePayloadHash, type WagerBusinessPayload } from '../../src/modules/wagering/application/payload-hash';
import { WagerTransactionKind } from '../../src/modules/wagering/domain/wager-transaction-kind';
import { brl, usd } from './fixtures/builders';

const base: WagerBusinessPayload = {
  providerId: 'provider-a',
  externalTransactionId: 'transaction-123',
  playerId: 'p1',
  walletId: 'w1',
  roundId: 'round-987',
  gameId: 'fortune-chimp',
  kind: WagerTransactionKind.Bet,
  money: brl('25.00'),
};

describe('canonicalJson', () => {
  test('ordena chaves recursivamente e omite undefined', () => {
    expect(canonicalJson({ b: 1 === 1, a: { d: 'x', c: null }, z: undefined })).toBe('{"a":{"c":null,"d":"x"},"b":true}');
  });

  test('ordem de inserção das chaves não altera o resultado', () => {
    expect(canonicalJson({ a: 'a', b: 'b' })).toBe(canonicalJson({ b: 'b', a: 'a' }));
  });

  test('rejeita números, Date e instâncias de classe', () => {
    expect(() => canonicalJson({ amount: 25 })).toThrow(TypeError);
    expect(() => canonicalJson({ at: new Date() })).toThrow(TypeError);
    expect(() => canonicalJson({ m: brl('1.00') })).toThrow(TypeError);
  });
});

describe('computePayloadHash', () => {
  test('é SHA-256 hex determinístico', () => {
    const h = computePayloadHash(base);
    expect(h).toMatch(/^[0-9a-f]{64}$/);
    expect(computePayloadHash({ ...base })).toBe(h);
  });

  test('escala do amount é normalizada: "25" ≡ "25.00"', () => {
    expect(computePayloadHash({ ...base, money: brl('25') })).toBe(computePayloadHash(base));
  });

  test('idempotency key com payload divergente → hashes diferentes (conflito, não replay)', () => {
    const h = computePayloadHash(base);
    const variants: Partial<WagerBusinessPayload>[] = [
      { money: brl('25.01') },
      { money: usd('25.00') },
      { kind: WagerTransactionKind.Win },
      { walletId: 'w2' },
      { playerId: 'p2' },
      { roundId: 'r2' },
      { gameId: 'g2' },
      { referenceExternalTransactionId: 'x' },
    ];
    for (const v of variants) expect(computePayloadHash({ ...base, ...v })).not.toBe(h);
  });

  test('referência ausente é omitida, não vira null', () => {
    expect(computePayloadHash({ ...base, referenceExternalTransactionId: undefined })).toBe(computePayloadHash(base));
  });
});
