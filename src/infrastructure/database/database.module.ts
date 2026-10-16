import { MikroOrmModule } from '@mikro-orm/nestjs';
import { PostgreSqlDriver } from '@mikro-orm/postgresql';
import { Module } from '@nestjs/common';
import { ENV, type Env } from '../../config/env';
import { buildOrmConfig } from './mikro-orm.config';

@Module({
  imports: [
    MikroOrmModule.forRootAsync({
      inject: [ENV],
      useFactory: (env: Env) => buildOrmConfig(env),
      // `driver` registra também os tokens específicos do Postgres
      // (MikroORM/EntityManager de @mikro-orm/postgresql) no container do Nest.
      driver: PostgreSqlDriver,
    }),
  ],
})
export class DatabaseModule {}
