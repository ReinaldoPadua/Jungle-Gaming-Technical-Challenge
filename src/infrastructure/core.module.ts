import { MikroORM } from '@mikro-orm/postgresql';
import { Controller, Get, Global, Header, Inject, Module, Res } from '@nestjs/common';
import type { HttpResponse as Response } from '../interface/http/http-types';
import { ENV, type Env } from '../config/env';
import { CLOCK, systemClock } from '../shared/application/clock';
import { FAULTS, faultsFromEnv } from '../shared/application/faults';
import { ID_GENERATOR, uuidV7Generator } from '../shared/application/id-generator';
import { APP_LOGGER, jsonLogger } from '../shared/application/logger';
import { METRICS } from '../shared/application/metrics';
import { UNIT_OF_WORK } from '../shared/application/unit-of-work';
import { DEFAULT_UOW_CONFIG, MikroUnitOfWork } from './database/mikro-unit-of-work';
import { PromMetrics } from './observability/prom-metrics';

@Controller()
class MetricsController {
  constructor(@Inject(METRICS) private readonly metrics: PromMetrics) {}

  @Get('metrics')
  @Header('Cache-Control', 'no-store')
  async scrape(@Res() res: Response) {
    res.setHeader('Content-Type', this.metrics.contentType);
    res.send(await this.metrics.metrics());
  }
}

/** Implementações das portas compartilhadas da camada de aplicação. */
@Global()
@Module({
  controllers: [MetricsController],
  providers: [
    { provide: CLOCK, useValue: systemClock },
    { provide: ID_GENERATOR, useValue: uuidV7Generator },
    { provide: APP_LOGGER, useValue: jsonLogger },
    { provide: FAULTS, inject: [ENV], useFactory: (env: Env) => faultsFromEnv(env) },
    {
      provide: METRICS,
      inject: [ENV],
      useFactory: (env: Env) => new PromMetrics({ defaultMetrics: env.NODE_ENV !== 'test', instanceId: env.INSTANCE_ID }),
    },
    {
      provide: UNIT_OF_WORK,
      inject: [MikroORM, METRICS, ENV],
      useFactory: (orm: MikroORM, metrics: PromMetrics, env: Env) =>
        new MikroUnitOfWork(orm, metrics, {
          ...DEFAULT_UOW_CONFIG,
          lockTimeoutMs: env.DB_LOCK_TIMEOUT_MS,
          statementTimeoutMs: env.DB_STATEMENT_TIMEOUT_MS,
        }),
    },
  ],
  exports: [CLOCK, ID_GENERATOR, APP_LOGGER, METRICS, UNIT_OF_WORK, FAULTS],
})
export class CoreModule {}
