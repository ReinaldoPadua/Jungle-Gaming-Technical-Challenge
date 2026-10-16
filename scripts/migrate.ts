/**
 * Executa migrations programaticamente (evita depender da CLI do MikroORM sob Bun).
 *   bun scripts/migrate.ts up | down | status | redo
 */
import 'reflect-metadata';
import { MikroORM } from '@mikro-orm/postgresql';
import { loadEnv } from '../src/config/env';
import { buildOrmConfig } from '../src/infrastructure/database/mikro-orm.config';

const command = process.argv[2] ?? 'up';
const orm = await MikroORM.init(buildOrmConfig(loadEnv()));
const migrator = orm.getMigrator();

try {
  switch (command) {
    case 'up': {
      const applied = await migrator.up();
      console.log(`applied ${applied.length} migration(s)`, applied.map((m) => m.name));
      break;
    }
    case 'down': {
      const reverted = await migrator.down();
      console.log(`reverted ${reverted.length} migration(s)`, reverted.map((m) => m.name));
      break;
    }
    case 'redo': {
      await migrator.down();
      await migrator.up();
      console.log('redo ok');
      break;
    }
    case 'status': {
      const executed = await migrator.getExecutedMigrations();
      const pending = await migrator.getPendingMigrations();
      console.log({ executed: executed.map((m) => m.name), pending: pending.map((m) => m.name) });
      break;
    }
    default:
      throw new Error(`unknown command "${command}" (use up | down | status | redo)`);
  }
} finally {
  await orm.close(true);
}
