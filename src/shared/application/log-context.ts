import { AsyncLocalStorage } from 'node:async_hooks';

/** Campos de correlação exigidos em todos os logs (seção 12). */
export interface LogContext {
  correlationId?: string;
  messageId?: string;
  transactionId?: string;
  walletId?: string;
  providerId?: string;
}

const storage = new AsyncLocalStorage<LogContext>();

/**
 * Contexto de log por fluxo de execução (requisição HTTP, mensagem SQS, item de
 * worker). Propaga-se por await/promises sem precisar passar parâmetros; fluxos
 * concorrentes não se misturam.
 */
export const logContext = {
  run<T>(ctx: LogContext, fn: () => T): T {
    // herda o contexto atual (ex.: correlationId da requisição) e sobrepõe
    return storage.run({ ...storage.getStore(), ...ctx }, fn);
  },
  /** Acrescenta campos ao contexto corrente (ex.: transactionId depois de gerado). */
  enrich(fields: LogContext): void {
    const store = storage.getStore();
    if (store) Object.assign(store, stripUndefined(fields));
  },
  current(): Readonly<LogContext> {
    return storage.getStore() ?? {};
  },
};

function stripUndefined(o: LogContext): LogContext {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined));
}
