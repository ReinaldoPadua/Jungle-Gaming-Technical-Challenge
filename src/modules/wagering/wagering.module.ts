import { Module } from '@nestjs/common';
import { CLOCK, type Clock } from '../../shared/application/clock';
import { ID_GENERATOR, type IdGenerator } from '../../shared/application/id-generator';
import { APP_LOGGER, type AppLogger } from '../../shared/application/logger';
import { METRICS, type Metrics } from '../../shared/application/metrics';
import { UNIT_OF_WORK, type UnitOfWork } from '../../shared/application/unit-of-work';
import { ProcessWagerTransactionUseCase } from './application/process-wager-transaction.use-case';
import { GetWagerTransactionQuery } from './application/wager-queries';
import { DEFAULT_REFERENCE_RETRY_POLICY, type ReferenceRetryPolicy } from './domain/reference-retry-policy';
import { WageringController } from './interface/http/wagering.controller';
import { GET_WAGER, PROCESS_WAGER, REFERENCE_RETRY_POLICY } from './wagering.tokens';

@Module({
  controllers: [WageringController],
  providers: [
    { provide: REFERENCE_RETRY_POLICY, useValue: DEFAULT_REFERENCE_RETRY_POLICY },
    {
      provide: PROCESS_WAGER,
      inject: [UNIT_OF_WORK, CLOCK, ID_GENERATOR, METRICS, REFERENCE_RETRY_POLICY, APP_LOGGER],
      useFactory: (uow: UnitOfWork, clock: Clock, ids: IdGenerator, metrics: Metrics, policy: ReferenceRetryPolicy, logger: AppLogger) =>
        new ProcessWagerTransactionUseCase(uow, clock, ids, metrics, policy, logger),
    },
    { provide: GET_WAGER, inject: [UNIT_OF_WORK], useFactory: (uow: UnitOfWork) => new GetWagerTransactionQuery(uow) },
  ],
  // o consumidor SQS (fase 6) reutiliza o MESMO use case
  exports: [PROCESS_WAGER, REFERENCE_RETRY_POLICY],
})
export class WageringModule {}
