import { Module } from '@nestjs/common';
import { ConfigModule } from './config/config.module';
import { HealthModule } from './health/health.module';
import { CoreModule } from './infrastructure/core.module';
import { DatabaseModule } from './infrastructure/database/database.module';
import { MessagingModule } from './infrastructure/messaging/messaging.module';
import { OutboxModule } from './modules/messaging/outbox.module';
import { WagerConsumerModule } from './modules/wagering/wager-consumer.module';
import { WageringModule } from './modules/wagering/wagering.module';
import { WalletModule } from './modules/wallet/wallet.module';

@Module({
  imports: [ConfigModule, DatabaseModule, CoreModule, MessagingModule, HealthModule, WalletModule, WageringModule, OutboxModule, WagerConsumerModule],
})
export class AppModule {}
