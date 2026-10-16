import { Migrator } from '@mikro-orm/migrations';
import { defineConfig, type Options } from '@mikro-orm/postgresql';
import type { Env } from '../../config/env';

/**
 * Configuração única do MikroORM, usada pela aplicação, pelo script de
 * migrations e pelos testes. O domínio não conhece o ORM: as entidades serão
 * mapeadas via EntitySchema na camada de infraestrutura (fase 2).
 */
export function buildOrmConfig(env: Pick<Env, 'DATABASE_URL' | 'DB_POOL_MAX' | 'NODE_ENV'>): Options {
  return defineConfig({
    clientUrl: env.DATABASE_URL,
    entities: [],
    discovery: { warnWhenNoEntities: false },
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
  });
}
