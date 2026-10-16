import 'reflect-metadata';
import { type INestApplication, type Type } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { HttpExceptionFilter } from './interface/http/http-exception.filter';
import { APP_LOGGER, type AppLogger } from './shared/application/logger';

/** Configuração HTTP comum à aplicação e aos testes. */
export function configureApp(app: INestApplication): INestApplication {
  app.useGlobalFilters(new HttpExceptionFilter(app.get<AppLogger>(APP_LOGGER)));
  // SIGTERM/SIGINT → OnModuleDestroy/OnApplicationShutdown (drain de consumers nas fases 5–6)
  app.enableShutdownHooks();
  return app;
}

/** Cria a aplicação sem escutar porta — reutilizado por main.ts e pelos testes. */
export async function createApp(module: Type<unknown> = AppModule): Promise<INestApplication> {
  const app = await NestFactory.create(module, { bufferLogs: false, abortOnError: false, logger: ['error', 'warn'] });
  return configureApp(app);
}
