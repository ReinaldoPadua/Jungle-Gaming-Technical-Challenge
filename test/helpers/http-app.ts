import 'reflect-metadata';
import { type INestApplication, Module, type Type } from '@nestjs/common';
import { createApp } from '../../src/bootstrap';
import { ConfigModule } from '../../src/config/config.module';
import { CoreModule } from '../../src/infrastructure/core.module';
import { AuthModule } from '../../src/modules/auth/auth.module';
import { DatabaseModule } from '../../src/infrastructure/database/database.module';
import { PendingReferenceModule } from '../../src/modules/wagering/pending-reference.module';
import { WageringModule } from '../../src/modules/wagering/wagering.module';
import { WalletModule } from '../../src/modules/wallet/wallet.module';

/** Aplicação HTTP sem SQS (wallet + wagering + core) — para suítes que não dependem da LocalStack. */
@Module({ imports: [ConfigModule, DatabaseModule, CoreModule, AuthModule, WalletModule, WageringModule] })
export class WalletHttpTestModule {}

/** Igual, mais o worker de PENDING_REFERENCE (liga com PENDING_WORKER_ENABLED=true). */
@Module({ imports: [WalletHttpTestModule, PendingReferenceModule] })
export class WorkersHttpTestModule {}

export interface HttpTestApp {
  app: INestApplication;
  url: string;
  get<T = any>(path: string, headers?: Record<string, string>): Promise<{ status: number; body: T; headers: Headers }>;
  post<T = any>(path: string, body?: unknown, headers?: Record<string, string>): Promise<{ status: number; body: T; headers: Headers }>;
  close(): Promise<void>;
}

export async function startHttpApp(module: Type<unknown> = WalletHttpTestModule, port = 0): Promise<HttpTestApp> {
  const app = await createApp(module);
  app.useLogger(false);
  await app.listen(port, '127.0.0.1');
  const url = (await app.getUrl()).replace('[::1]', '127.0.0.1');
  const call = async (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) => {
    const res = await fetch(`${url}${path}`, {
      method,
      headers: { 'content-type': 'application/json', ...headers },
      body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
    });
    const text = await res.text();
    return { status: res.status, body: text && res.headers.get('content-type')?.includes('json') ? JSON.parse(text) : text, headers: res.headers };
  };
  return {
    app,
    url,
    get: (p, h) => call('GET', p, undefined, h),
    post: (p, b, h) => call('POST', p, b, h),
    close: () => app.close(),
  };
}
