/**
 * Hierarquia de erros do domínio.
 *
 * - DomainError: violação de regra que o chamador pode tratar (vira resposta/failureCode).
 * - InvariantViolationError: erro de programação — o código tentou algo que nunca
 *   deveria acontecer (ex.: transicionar uma transação terminal). Não é caminho de negócio.
 */
export abstract class DomainError extends Error {
  abstract readonly code: string;

  protected constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

export class InvalidMoneyError extends DomainError {
  readonly code = 'INVALID_MONEY';
  constructor(message: string) {
    super(message);
  }
}

export class CurrencyMismatchError extends DomainError {
  readonly code = 'CURRENCY_MISMATCH';
  constructor(
    readonly expected: string,
    readonly actual: string,
  ) {
    super(`currency mismatch: expected ${expected}, got ${actual}`);
  }
}

/** Entrada que viola o contrato (vira 400 na borda). */
export class InvalidArgumentError extends DomainError {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export class InvariantViolationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}
