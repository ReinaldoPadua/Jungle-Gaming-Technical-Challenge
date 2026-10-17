/** Porta de log estruturado. Implementação: infrastructure/observability/json-logger.ts */
export interface AppLogger {
  debug?(msg: string, fields?: Record<string, unknown>): void;
  info(msg: string, fields?: Record<string, unknown>): void;
  warn(msg: string, fields?: Record<string, unknown>): void;
  error(msg: string, fields?: Record<string, unknown>): void;
}

export const APP_LOGGER = Symbol('APP_LOGGER');
