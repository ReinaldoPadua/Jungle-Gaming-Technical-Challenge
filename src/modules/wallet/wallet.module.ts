import { Module } from '@nestjs/common';
import { CLOCK, type Clock } from '../../shared/application/clock';
import { ID_GENERATOR, type IdGenerator } from '../../shared/application/id-generator';
import { APP_LOGGER, type AppLogger } from '../../shared/application/logger';
import { METRICS, type Metrics } from '../../shared/application/metrics';
import { UNIT_OF_WORK, type UnitOfWork } from '../../shared/application/unit-of-work';
import { OpenWalletUseCase } from './application/open-wallet.use-case';
import { ReconcileWalletUseCase } from './application/reconcile-wallet.use-case';
import { GetWalletLedgerQuery, GetWalletQuery } from './application/wallet-queries';
import { WalletsController } from './interface/http/wallets.controller';
import { GET_WALLET, GET_WALLET_LEDGER, OPEN_WALLET, RECONCILE_WALLET } from './wallet.tokens';

/** Use cases são classes puras (sem decorators do Nest); o módulo só faz a composição. */
@Module({
  controllers: [WalletsController],
  providers: [
    {
      provide: OPEN_WALLET,
      inject: [UNIT_OF_WORK, CLOCK, ID_GENERATOR, METRICS],
      useFactory: (uow: UnitOfWork, clock: Clock, ids: IdGenerator, metrics: Metrics) =>
        new OpenWalletUseCase(uow, clock, ids, metrics),
    },
    { provide: GET_WALLET, inject: [UNIT_OF_WORK], useFactory: (uow: UnitOfWork) => new GetWalletQuery(uow) },
    { provide: GET_WALLET_LEDGER, inject: [UNIT_OF_WORK], useFactory: (uow: UnitOfWork) => new GetWalletLedgerQuery(uow) },
    {
      provide: RECONCILE_WALLET,
      inject: [UNIT_OF_WORK, CLOCK, METRICS, APP_LOGGER],
      useFactory: (uow: UnitOfWork, clock: Clock, metrics: Metrics, logger: AppLogger) =>
        new ReconcileWalletUseCase(uow, clock, metrics, logger),
    },
  ],
})
export class WalletModule {}
