import { Migrator } from '@mikro-orm/migrations';
import { defineConfig, type Options } from '@mikro-orm/postgresql';
import type { Env } from '../../config/env';
import { ENTITY_SCHEMAS } from './entities';

/**
 * Configuração única do MikroORM, usada pela aplicação, pelo script de
 * migrations e pelos testes. O domínio não conhece o ORM: registros de
 * persistência são mapeados via EntitySchema e convertidos por mappers.
 */
export function buildOrmConfig(env: Pick<Env, 'DATABASE_URL' | 'DB_POOL_MAX' | 'NODE_ENV'>): Options {
  return defineConfig({
    clientUrl: env.DATABASE_URL,
    entities: ENTITY_SCHEMAS,
    // Bun executa TS nativamente: carregar migrations .ts direto da pasta.
    preferTs: true,
    extensions: [Migrator],
    migrations: {
      tableName: 'mikro_orm_migrations',
      path: 'migrations',
      pathTs: 'migrations',
      glob: '!(*.d).{js,ts}',
      transactional: true,
      allOrNothing: true,
      snapshot: false,
      emit: 'ts',
    },
    pool: { min: 0, max: env.DB_POOL_MAX },
    // Toda operação deve rodar num EntityManager forkado (por request/mensagem).
    allowGlobalContext: false,
    // timestamps sempre em UTC. (numeric do Postgres volta como string pelo
    // driver `pg` — nunca number — o que preserva a exatidão do Money.)
    forceUtcTimezone: true,
    debug: false,
    // silencia o log do migrator durante os testes
    logger: (msg) => {
      if (env.NODE_ENV !== 'test') process.stdout.write(`${JSON.stringify({ level: 'info', time: new Date().toISOString(), msg: 'mikro-orm', detail: msg })}\n`);
    },
  });
}
