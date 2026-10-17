import { logContext } from '../../shared/application/log-context';
import { CorrelationIdHeader } from './schemas';

/** Valida o X-Correlation-Id recebido; gera um novo se ausente ou malformado. */
export function correlationIdFromHeader(header: string | undefined): string {
  const parsed = CorrelationIdHeader.safeParse(header);
  return parsed.success && parsed.data ? parsed.data : Bun.randomUUIDv7();
}

/** correlationId do fluxo atual (definido pelo middleware HTTP); fallback no header. */
export function resolveCorrelationId(header?: string): string {
  return logContext.current().correlationId ?? correlationIdFromHeader(header);
}
