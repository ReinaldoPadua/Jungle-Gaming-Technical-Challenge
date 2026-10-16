import { describe, expect, test } from 'bun:test';
import { ValidationError } from '../../src/shared/application/errors';
import { LedgerCursor } from '../../src/modules/wallet/application/ledger-cursor';
import { classifyDbError, isLockConflict, isUniqueViolation } from '../../src/infrastructure/database/db-errors';

describe('LedgerCursor', () => {
  test('round-trip e opacidade (base64url, sem caracteres especiais)', () => {
    const c = LedgerCursor.encode('w-1', 42);
    expect(c).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(LedgerCursor.decode(c, 'w-1')).toBe(42);
  });

  test.each([
    ['lixo', 'zzz'],
    ['JSON sem campos', Buffer.from('{}').toString('base64url')],
    ['sequence inválida', Buffer.from(JSON.stringify({ v: 1, w: 'w-1', s: 0 })).toString('base64url')],
    ['sequence fracionária', Buffer.from(JSON.stringify({ v: 1, w: 'w-1', s: 1.5 })).toString('base64url')],
    ['versão desconhecida', Buffer.from(JSON.stringify({ v: 2, w: 'w-1', s: 3 })).toString('base64url')],
  ])('rejeita %s', (_l, cursor) => {
    expect(() => LedgerCursor.decode(cursor, 'w-1')).toThrow(ValidationError);
  });

  test('rejeita cursor emitido para outra wallet', () => {
    expect(() => LedgerCursor.decode(LedgerCursor.encode('w-2', 5), 'w-1')).toThrow(ValidationError);
  });
});

describe('classifyDbError', () => {
  const pg = (code: string, constraint?: string) => Object.assign(new Error('pg'), { code, constraint });

  test.each(['40001', '40P01', '55P03', '57014', '08006', '53300', 'ECONNREFUSED'])('%s é transitório', (code) => {
    expect(classifyDbError(pg(code))).toBe('transient');
  });

  test.each(['23505', '23514', '23503', '23001'])('%s é violação de integridade (nunca retry)', (code) => {
    expect(classifyDbError(pg(code))).toBe('integrity');
  });

  test('outros erros e erros sem SQLSTATE', () => {
    expect(classifyDbError(pg('42P01'))).toBe('other');
    expect(classifyDbError(new Error('boom'))).toBe('other');
    expect(classifyDbError(new Error('Knex: Timeout acquiring a connection. The pool is probably full.'))).toBe('transient');
  });

  test('helpers', () => {
    expect(isUniqueViolation(pg('23505', 'x'), 'x')).toBe(true);
    expect(isUniqueViolation(pg('23505', 'y'), 'x')).toBe(false);
    expect(isLockConflict(pg('55P03'))).toBe(true);
    expect(isLockConflict(pg('40001'))).toBe(false);
  });
});
