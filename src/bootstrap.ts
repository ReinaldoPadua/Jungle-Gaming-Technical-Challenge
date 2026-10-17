import 'reflect-metadata';
import { type INestApplication, type Type } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { loadEnv } from './config/env';
import { HttpExceptionFilter } from './interface/http/http-exception.filter';
import { requestContextMiddleware } from './interface/http/request-context.middleware';
import { JsonLogger } from './infrastructure/observability/json-logger';
import { APP_LOGGER, type AppLogger } from './shared/application/logger';
import { METRICS, type Metrics } from './shared/application/metrics';

/** Configuração HTTP comum à aplicação e aos testes. */
export function configureApp(app: INestApplication): INestApplication {
  const logger = app.get<AppLogger>(APP_LOGGER);
  // primeiro middleware: todo o resto da requisição roda dentro do contexto de log
  app.use(requestContextMiddleware(logger, app.get<Metrics>(METRICS)));
  app.useGlobalFilters(new HttpExceptionFilter(logger));
  // SIGTERM/SIGINT → beforeApplicationShutdown (drain de consumer/workers) → fecha o ORM
  app.enableShutdownHooks();
  return app;
}

/** Cria a aplicação sem escutar porta — reutilizado por main.ts e pelos testes. */
export async function createApp(module: Type<unknown> = AppModule): Promise<INestApplication> {
  const env = loadEnv();
  const app = await NestFactory.create(module, {
    abortOnError: false,
    // logs do próprio Nest também em JSON (só warn/error para não poluir)
    logger: new JsonLogger({ level: 'warn', service: 'wagering', instanceId: env.INSTANCE_ID }),
  });
  return configureApp(app);
}
