/** Logger estruturado mínimo (a fase 8 troca a implementação por pino + contexto ALS). */
export interface AppLogger {
  info(msg: string, fields?: Record<string, unknown>): void;
  warn(msg: string, fields?: Record<string, unknown>): void;
  error(msg: string, fields?: Record<string, unknown>): void;
}

export const APP_LOGGER = Symbol('APP_LOGGER');

const write = (level: string, msg: string, fields?: Record<string, unknown>) =>
  console.log(JSON.stringify({ level, time: new Date().toISOString(), msg, ...fields }));

export const jsonLogger: AppLogger = {
  info: (m, f) => write('info', m, f),
  warn: (m, f) => write('warn', m, f),
  error: (m, f) => write('error', m, f),
};
