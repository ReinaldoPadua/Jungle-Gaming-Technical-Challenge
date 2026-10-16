import { type ArgumentsHost, Catch, type ExceptionFilter, HttpException, HttpStatus } from '@nestjs/common';
import type { HttpResponse as Response } from './http-types';
import { ApplicationError, TransientError } from '../../shared/application/errors';
import type { AppLogger } from '../../shared/application/logger';
import { DomainError } from '../../shared/domain/errors';
import { classifyDbError } from '../../infrastructure/database/db-errors';

export interface ErrorBody {
  error: { code: string; message: string; details?: unknown };
}

const STATUS_BY_KIND: Record<ApplicationError['kind'], number> = {
  validation: HttpStatus.BAD_REQUEST,
  not_found: HttpStatus.NOT_FOUND,
  conflict: HttpStatus.CONFLICT,
  transient: HttpStatus.SERVICE_UNAVAILABLE,
};

/**
 * Mapeamento ÚNICO de erro → HTTP para todos os endpoints:
 *
 *   400 payload inválido (contrato, Money, regra de formato do domínio)
 *   404 recurso inexistente
 *   409 conflito (idempotency key com payload diferente, wallet duplicada)
 *   422 rejeição por regra de negócio (fase 4 — corpo traz o resultado da transação)
 *   202 aceito com processamento pendente (fase 4)
 *   503 falha transitória de infraestrutura + Retry-After (o cliente pode reenviar)
 *   500 erro inesperado (bug) — nunca expõe detalhes internos
 */
@Catch()
export class HttpExceptionFilter implements ExceptionFilter {
  constructor(private readonly logger: AppLogger) {}

  catch(exception: unknown, host: ArgumentsHost): void {
    const res = host.switchToHttp().getResponse<Response>();
    const { status, body, retryAfter } = this.map(exception);
    if (status >= 500 && status !== HttpStatus.SERVICE_UNAVAILABLE) {
      this.logger.error('unhandled error', {
        error: exception instanceof Error ? { name: exception.name, message: exception.message, stack: exception.stack } : String(exception),
      });
    }
    if (retryAfter !== undefined) res.setHeader('Retry-After', String(retryAfter));
    res.status(status).json(body);
  }

  private map(e: unknown): { status: number; body: ErrorBody; retryAfter?: number } {
    if (e instanceof ApplicationError) {
      return {
        status: STATUS_BY_KIND[e.kind],
        body: { error: { code: e.code, message: e.message, ...(e.details !== undefined ? { details: e.details } : {}) } },
        retryAfter: e instanceof TransientError ? e.retryAfterSeconds : undefined,
      };
    }
    if (e instanceof DomainError) {
      // erros de domínio que chegam à borda são violações de contrato de entrada
      return { status: HttpStatus.BAD_REQUEST, body: { error: { code: e.code, message: e.message } } };
    }
    if (e instanceof HttpException) {
      const status = e.getStatus();
      const code = status === HttpStatus.NOT_FOUND ? 'ROUTE_NOT_FOUND' : status === 400 ? 'BAD_REQUEST' : `HTTP_${status}`;
      return { status, body: { error: { code, message: e.message } } };
    }
    if (classifyDbError(e) === 'transient') {
      return {
        status: HttpStatus.SERVICE_UNAVAILABLE,
        body: { error: { code: 'TEMPORARILY_UNAVAILABLE', message: 'database temporarily unavailable, retry later' } },
        retryAfter: 1,
      };
    }
    return { status: HttpStatus.INTERNAL_SERVER_ERROR, body: { error: { code: 'INTERNAL_ERROR', message: 'internal error' } } };
  }
}
