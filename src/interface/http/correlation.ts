import { CorrelationIdHeader } from './schemas';

/** Usa o X-Correlation-Id recebido (se bem formado) ou gera um novo. */
export function resolveCorrelationId(header: string | undefined): string {
  const parsed = CorrelationIdHeader.safeParse(header);
  return parsed.success && parsed.data ? parsed.data : Bun.randomUUIDv7();
}
