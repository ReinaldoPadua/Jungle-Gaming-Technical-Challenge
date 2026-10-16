/**
 * Política de espera por referências fora de ordem (PENDING_REFERENCE).
 *
 * Defaults: backoff exponencial 500ms → 60s, até 10 tentativas OU 15 minutos
 * desde a criação (o que vier primeiro). Provedores costumam entregar a
 * referência em segundos; passados 15 min é um incidente, e manter a
 * transação pendente só atrasaria a sinalização ao provedor.
 */
export interface ReferenceRetryPolicy {
  readonly maxAttempts: number;
  readonly baseDelayMs: number;
  readonly maxDelayMs: number;
  readonly ttlMs: number;
}

export const DEFAULT_REFERENCE_RETRY_POLICY: ReferenceRetryPolicy = Object.freeze({
  maxAttempts: 10,
  baseDelayMs: 500,
  maxDelayMs: 60_000,
  ttlMs: 15 * 60_000,
});

/** Atraso antes da tentativa `attempt` (1-based): base · 2^(attempt-1), limitado a maxDelay. */
export function referenceRetryDelayMs(policy: ReferenceRetryPolicy, attempt: number): number {
  const exp = policy.baseDelayMs * 2 ** Math.max(0, attempt - 1);
  return Math.min(exp, policy.maxDelayMs);
}
