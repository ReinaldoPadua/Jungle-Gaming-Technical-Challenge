/**
 * Spike 2 — MikroORM sob Bun contra PostgreSQL real:
 *  - migrations .ts carregadas sem build, up → down → up reversível
 *  - numeric volta como string (exatidão para Money)
 *  - SELECT … FOR UPDATE bloqueia de fato uma segunda conexão
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { MikroORM } from '@mikro-orm/postgresql';
import Big from 'big.js';
import { initOrm } from '../helpers/infra';

let orm: MikroORM;

beforeAll(async () => {
  orm = await initOrm();
});
afterAll(async () => {
  await orm?.close(true);
});

const fnExists = async () => {
  const rows = await orm.em.getConnection().execute<{ n: string }[]>(
    `select count(*)::text as n from pg_proc where proname = 'forbid_mutation'`,
  );
  return rows[0]?.n === '1';
};

describe('spike: MikroORM + PostgreSQL on Bun', () => {
  test('migrations are reversible (up → down → up)', async () => {
    const migrator = orm.getMigrator();
    await migrator.up();
    expect(await fnExists()).toBe(true);

    await migrator.down({ to: 0 });
    expect(await fnExists()).toBe(false);

    await migrator.up();
    expect(await fnExists()).toBe(true);
    expect(await migrator.getPendingMigrations()).toHaveLength(0);
  });

  test('numeric round-trips as string, never number', async () => {
    const [row] = await orm.em
      .getConnection()
      .execute<{ v: unknown }[]>(`select ('0.10'::numeric(20,2) + '0.20'::numeric(20,2)) as v`);
    expect(typeof row?.v).toBe('string');
    expect(row?.v).toBe('0.30');
    expect(new Big('0.10').plus('0.20').toFixed(2)).toBe('0.30');
  });

  test('SELECT … FOR UPDATE serializes two concurrent transactions on the same row', async () => {
    const conn = orm.em.getConnection();
    await conn.execute('drop table if exists spike_lock');
    await conn.execute('create table spike_lock (id int primary key, v int not null)');
    await conn.execute('insert into spike_lock values (1, 0)');

    const order: string[] = [];
    const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

    const t1 = orm.em.fork().transactional(async (em) => {
      await em.execute('select * from spike_lock where id = 1 for update');
      order.push('t1:locked');
      await sleep(300);
      await em.execute('update spike_lock set v = v + 1 where id = 1');
      order.push('t1:commit');
    });
    await sleep(50);
    const t2 = orm.em.fork().transactional(async (em) => {
      await em.execute('select * from spike_lock where id = 1 for update');
      order.push('t2:locked');
      await em.execute('update spike_lock set v = v + 1 where id = 1');
    });
    await Promise.all([t1, t2]);

    expect(order).toEqual(['t1:locked', 't1:commit', 't2:locked']);
    const [row] = await conn.execute<{ v: number }[]>('select v from spike_lock where id = 1');
    expect(row?.v).toBe(2);
    await conn.execute('drop table spike_lock');
  });
});
