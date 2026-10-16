/**
 * Classificação de erros do PostgreSQL (SQLSTATE) — decide retry vs. falha.
 *   transient: vale tentar de novo (mesma requisição pode ter sucesso)
 *   integrity: violação de constraint (23xxx) — bug ou dado inválido, nunca retry
 *   other:     qualquer outro erro
 */
export type DbErrorClass = 'transient' | 'integrity' | 'other';

interface PgLikeError {
  code?: unknown;
  constraint?: unknown;
}

const TRANSIENT_SQLSTATES = new Set([
  '40001', // serialization_failure
  '40P01', // deadlock_detected
  '55P03', // lock_not_available (lock_timeout)
  '57014', // query_canceled (statement_timeout)
  '57P01', // admin_shutdown
  '57P02', // crash_shutdown
  '57P03', // cannot_connect_now
  '53300', // too_many_connections
]);

const TRANSIENT_NODE_CODES = new Set(['ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'EPIPE', 'ENOTFOUND', 'EAI_AGAIN']);

export function sqlStateOf(err: unknown): string | undefined {
  const code = (err as PgLikeError | null)?.code;
  return typeof code === 'string' ? code : undefined;
}

export function constraintOf(err: unknown): string | undefined {
  const c = (err as PgLikeError | null)?.constraint;
  return typeof c === 'string' ? c : undefined;
}

export function classifyDbError(err: unknown): DbErrorClass {
  const code = sqlStateOf(err);
  if (!code) {
    // erros de conexão do driver/knex sem SQLSTATE
    const msg = err instanceof Error ? err.message : '';
    if (/Knex: Timeout acquiring a connection|Connection terminated/i.test(msg)) return 'transient';
    return 'other';
  }
  if (TRANSIENT_SQLSTATES.has(code) || code.startsWith('08') || TRANSIENT_NODE_CODES.has(code)) return 'transient';
  if (code.startsWith('23')) return 'integrity';
  return 'other';
}

export const isUniqueViolation = (err: unknown, constraint?: string) =>
  sqlStateOf(err) === '23505' && (constraint === undefined || constraintOf(err) === constraint);

/** lock_timeout / deadlock — contados como conflito de lock nas métricas. */
export const isLockConflict = (err: unknown) => ['40P01', '55P03'].includes(sqlStateOf(err) ?? '');
