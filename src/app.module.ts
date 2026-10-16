import { Module } from '@nestjs/common';
import { ConfigModule } from './config/config.module';
import { HealthModule } from './health/health.module';
import { CoreModule } from './infrastructure/core.module';
import { DatabaseModule } from './infrastructure/database/database.module';
import { MessagingModule } from './infrastructure/messaging/messaging.module';
import { WalletModule } from './modules/wallet/wallet.module';

@Module({
  imports: [ConfigModule, DatabaseModule, CoreModule, MessagingModule, HealthModule, WalletModule],
})
export class AppModule {}
