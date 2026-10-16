/**
 * Erros da camada de aplicação. A borda HTTP mapeia `kind` → status de forma
 * única para todos os endpoints (ver http-exception.filter.ts):
 *
 *   validation → 400   not_found → 404   conflict → 409   transient → 503
 */
export type ApplicationErrorKind = 'validation' | 'not_found' | 'conflict' | 'transient';

export abstract class ApplicationError extends Error {
  abstract readonly kind: ApplicationErrorKind;

  protected constructor(
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = new.target.name;
  }
}

export class ValidationError extends ApplicationError {
  readonly kind = 'validation';
  constructor(message: string, details?: unknown, code = 'VALIDATION_ERROR') {
    super(code, message, details);
  }
}

export class NotFoundError extends ApplicationError {
  readonly kind = 'not_found';
  constructor(code: string, message: string) {
    super(code, message);
  }
}

export class ConflictError extends ApplicationError {
  readonly kind = 'conflict';
  constructor(code: string, message: string, details?: unknown) {
    super(code, message, details);
  }
}

/** Falha temporária de infraestrutura: o cliente PODE reenviar a mesma requisição. */
export class TransientError extends ApplicationError {
  readonly kind = 'transient';
  constructor(
    message: string,
    readonly retryAfterSeconds = 1,
    override readonly cause?: unknown,
  ) {
    super('TEMPORARILY_UNAVAILABLE', message);
  }
}
