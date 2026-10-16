import { hostname } from 'node:os';
import { z } from 'zod';

const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().min(0).max(65535).default(3000),
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
  INSTANCE_ID: z.string().min(1).default(`${hostname()}-${process.pid}`),

  DATABASE_URL: z.string().url(),
  DB_POOL_MAX: z.coerce.number().int().positive().default(10),

  AWS_REGION: z.string().min(1).default('us-east-1'),
  AWS_ACCESS_KEY_ID: z.string().min(1).default('test'),
  AWS_SECRET_ACCESS_KEY: z.string().min(1).default('test'),
  SQS_ENDPOINT: z.string().url().optional(),
  WAGER_QUEUE_NAME: z.string().endsWith('.fifo').default('wager-transactions.fifo'),
  WAGER_DLQ_NAME: z.string().endsWith('.fifo').default('wager-transactions-dlq.fifo'),
  EVENTS_QUEUE_NAME: z.string().endsWith('.fifo').default('wallet-events.fifo'),
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
