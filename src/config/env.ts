import { hostname } from 'node:os';
import { z } from 'zod';

const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().min(0).max(65535).default(3000),
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
  INSTANCE_ID: z.string().min(1).default(`${hostname()}-${process.pid}`),

  DATABASE_URL: z.string().url(),
  DB_POOL_MAX: z.coerce.number().int().positive().default(10),
  DB_LOCK_TIMEOUT_MS: z.coerce.number().int().positive().default(2_000),
  DB_STATEMENT_TIMEOUT_MS: z.coerce.number().int().positive().default(5_000),

  AWS_REGION: z.string().min(1).default('us-east-1'),
  AWS_ACCESS_KEY_ID: z.string().min(1).default('test'),
  AWS_SECRET_ACCESS_KEY: z.string().min(1).default('test'),
  SQS_ENDPOINT: z.string().url().optional(),
  WAGER_QUEUE_NAME: z.string().endsWith('.fifo').default('wager-transactions.fifo'),
  WAGER_DLQ_NAME: z.string().endsWith('.fifo').default('wager-transactions-dlq.fifo'),
  EVENTS_QUEUE_NAME: z.string().endsWith('.fifo').default('wallet-events.fifo'),

  OUTBOX_PUBLISHER_ENABLED: z
    .enum(['true', 'false'])
    .default('true')
    .transform((v) => v === 'true'),
  OUTBOX_BATCH_SIZE: z.coerce.number().int().min(1).max(500).default(50),
  OUTBOX_LEASE_MS: z.coerce.number().int().min(100).default(30_000),
  OUTBOX_POLL_INTERVAL_MS: z.coerce.number().int().min(10).default(200),

  /** injeção de falhas para testes de recuperação (ver shared/application/faults.ts) */
  FAULTS: z.string().optional(),
});

export type Env = Readonly<z.infer<typeof EnvSchema>>;

/** Lê e valida o ambiente. Falha rápido (no boot) com mensagem legível. */
export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const parsed = EnvSchema.safeParse(source);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `  - ${i.path.join('.')}: ${i.message}`).join('\n');
    throw new Error(`Invalid environment configuration:\n${issues}`);
  }
  return Object.freeze(parsed.data);
}

export const ENV = Symbol('ENV');
