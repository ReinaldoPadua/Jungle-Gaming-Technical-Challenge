import { Module } from '@nestjs/common';
import { ConfigModule } from './config/config.module';
import { HealthModule } from './health/health.module';
import { DatabaseModule } from './infrastructure/database/database.module';
import { MessagingModule } from './infrastructure/messaging/messaging.module';

@Module({
  imports: [ConfigModule, DatabaseModule, MessagingModule, HealthModule],
})
export class AppModule {}
