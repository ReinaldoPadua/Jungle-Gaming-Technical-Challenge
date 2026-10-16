import 'reflect-metadata';
import { type INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';

/** Cria a aplicação sem escutar porta — reutilizado por main.ts e pelos testes. */
export async function createApp(): Promise<INestApplication> {
  const app = await NestFactory.create(AppModule, { bufferLogs: false, abortOnError: false });
  // SIGTERM/SIGINT → OnModuleDestroy/OnApplicationShutdown (drain de consumers nas fases 5–6)
  app.enableShutdownHooks();
  return app;
}
