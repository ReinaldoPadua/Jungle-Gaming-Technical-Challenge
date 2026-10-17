import type { LoggerService } from '@nestjs/common';
import { logContext } from '../../shared/application/log-context';
import type { AppLogger } from '../../shared/application/logger';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';
const LEVELS: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

/**
 * Chaves cujo valor NUNCA vai para o log: valores monetários, payloads completos
 * e credenciais. A verificação é recursiva e por nome de chave (case-insensitive).
 */
const REDACTED_KEYS = /^(money|amount|balance|balance_?before|balance_?after|initial_?balance|stored_?balance|calculated_?balance|payload|body|data|authorization|cookie|password|secret|token|access_?token)$/i;
const MAX_DEPTH = 6;

export function redact(value: unknown, depth = 0): unknown {
  if (value === null || typeof value !== 'object') return value;
  if (depth >= MAX_DEPTH) return '[TRUNCATED]';
  if (value instanceof Error) return serializeError(value);
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1));
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, REDACTED_KEYS.test(k) ? '[REDACTED]' : redact(v, depth + 1)]),
  );
}

function serializeError(err: Error): Record<string, unknown> {
  const out: Record<string, unknown> = { name: err.name, message: err.message };
  const code = (err as { code?: unknown }).code;
  if (code !== undefined) out.code = code;
  if (err.stack) out.stack = err.stack.split('\n').slice(0, 8).join('\n');
  return out;
}

/** Destino das linhas — trocável nos testes para capturar a saída. */
let sink: (line: string) => void = (line) => process.stdout.write(`${line}\n`);
export const setLogSink = (fn: (line: string) => void) => {
  const previous = sink;
  sink = fn;
  return () => {
    sink = previous;
  };
};

/**
 * Logger JSON de uma linha por evento:
 *   { level, time, msg, service, instanceId, correlationId, messageId, transactionId, walletId, providerId, ...campos }
 * O contexto de correlação vem do AsyncLocalStorage (logContext) automaticamente.
 */
export class JsonLogger implements AppLogger, LoggerService {
  private readonly min: number;

  constructor(private readonly opts: { level: LogLevel; service?: string; instanceId?: string }) {
    this.min = LEVELS[opts.level];
  }

  debug(msg: string, fields?: Record<string, unknown>): void {
    this.write('debug', msg, fields);
  }
  info(msg: string, fields?: Record<string, unknown>): void {
    this.write('info', msg, fields);
  }
  warn(msg: string, fields?: Record<string, unknown>): void {
    this.write('warn', msg, fields);
  }
  error(msg: string, fields?: Record<string, unknown>): void {
    this.write('error', msg, fields);
  }

  // ---- LoggerService (logs internos do Nest)
  log(message: unknown, ...params: unknown[]): void {
    this.write('info', String(message), nestFields(params));
  }
  verbose(message: unknown, ...params: unknown[]): void {
    this.write('debug', String(message), nestFields(params));
  }
  fatal(message: unknown, ...params: unknown[]): void {
    this.write('error', String(message), nestFields(params));
  }

  private write(level: LogLevel, msg: string, fields?: Record<string, unknown> | unknown): void {
    if (LEVELS[level] < this.min) return;
    const extra = fields && typeof fields === 'object' && !Array.isArray(fields) ? (redact(fields) as Record<string, unknown>) : {};
    const line = {
      level,
      time: new Date().toISOString(),
      msg,
      ...(this.opts.service ? { service: this.opts.service } : {}),
      ...(this.opts.instanceId ? { instanceId: this.opts.instanceId } : {}),
      ...logContext.current(),
      ...extra,
    };
    try {
      sink(JSON.stringify(line));
    } catch {
      sink(JSON.stringify({ level, time: line.time, msg, logError: 'unserializable fields' }));
    }
  }
}

/** Nest passa (mensagem, ...[contexto]) — vira o campo `nestContext`. */
function nestFields(params: unknown[]): Record<string, unknown> {
  const context = params.at(-1);
  return typeof context === 'string' ? { nestContext: context } : {};
}
