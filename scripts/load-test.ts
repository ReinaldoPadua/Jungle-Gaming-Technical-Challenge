/**
 * Teste de carga — `bun run test:load`
 *
 * Metodologia (ver docs/LOAD_TEST.md):
 *  - N instâncias independentes (processos, pools próprios) contra o MESMO PostgreSQL;
 *  - C clientes concorrentes em loop fechado (cada um envia a próxima ao receber a resposta),
 *    distribuídos em round-robin entre as instâncias, por D segundos (após aquecimento);
 *  - mix: apostas/ganhos em wallets "frias" (baixa contenção), uma wallet "quente" (contenção
 *    máxima), LOSS, REFUND de apostas já aplicadas, apostas sem saldo (422) e REPLAYS;
 *  - um publisher de outbox real roda em paralelo (arquivo, ou SQS se LOAD_OUTBOX=sqs);
 *    o lag é amostrado no banco a cada 500 ms;
 *  - ao final: invariantes (saldo == ledger em todas as wallets, unicidade, nada pendente).
 *
 * Variáveis: LOAD_DURATION_S (30), LOAD_WARMUP_S (5), LOAD_CONCURRENCY (32), LOAD_INSTANCES (3),
 *            LOAD_WALLETS (200), LOAD_HOT_WEIGHT (12; 0 desliga a wallet quente),
 *            LOAD_OUTBOX (file|sqs|none), LOAD_REPORT (docs/load-test-results/latest.md)
 * Usa o banco de TESTE (recusa qualquer DATABASE_URL que não termine em _test) e o recria do zero.
 */
import 'reflect-metadata';
import { cpus, totalmem, type as osType, release as osRelease, arch } from 'node:os';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { MikroORM } from '@mikro-orm/postgresql';
import { loadEnv } from '../src/config/env';
import { buildOrmConfig } from '../src/infrastructure/database/mikro-orm.config';
import { createSqsClient, resolveQueueUrls } from '../src/infrastructure/messaging/sqs';
import { JsonLogger } from '../src/infrastructure/observability/json-logger';
import { PromMetrics } from '../src/infrastructure/observability/prom-metrics';
import { DEFAULT_OUTBOX_PUBLISHER_CONFIG, OutboxPublisher } from '../src/modules/messaging/application/outbox-publisher';
import type { EventPublisher } from '../src/modules/messaging/application/ports';
import { MikroOutboxStore } from '../src/modules/messaging/infrastructure/persistence/mikro-outbox-store';
import { SqsEventPublisher } from '../src/modules/messaging/infrastructure/sqs/sqs-event-publisher';
import { systemClock } from '../src/shared/application/clock';
import { noFaults } from '../src/shared/application/faults';
import { spawnInstance, stopInstances, type Instance } from '../test/helpers/instances';
import { FilePublisher } from '../test/helpers/outbox';

// ------------------------------------------------------------------ config
const num = (k: string, d: number) => Number(process.env[k] ?? d);
const CFG = {
  durationS: num('LOAD_DURATION_S', 30),
  warmupS: num('LOAD_WARMUP_S', 5),
  concurrency: num('LOAD_CONCURRENCY', 32),
  instances: num('LOAD_INSTANCES', 3),
  wallets: num('LOAD_WALLETS', 200),
  outbox: (process.env.LOAD_OUTBOX ?? 'file') as 'file' | 'sqs' | 'none',
  report: process.env.LOAD_REPORT ?? 'docs/load-test-results/latest.md',
};
const env = loadEnv();
if (!/_test(\?|$)/.test(env.DATABASE_URL)) throw new Error('load test only runs against a *_test database');
const log = (msg: string) => process.stderr.write(`[load] ${msg}\n`);

// ------------------------------------------------------------------ setup
const orm = await MikroORM.init(buildOrmConfig(env));
const conn = orm.em.getConnection();
await orm.getMigrator().down({ to: 0 });
await orm.getMigrator().up();
const pgVersion = ((await conn.execute(`select version() as v`)) as { v: string }[])[0]!.v.split(',')[0];
const maxConn = ((await conn.execute(`show max_connections`)) as { max_connections: string }[])[0]!.max_connections;

log(`spawning ${CFG.instances} instances…`);
const instances: Instance[] = await Promise.all(
  Array.from({ length: CFG.instances }, () =>
    spawnInstance({ INSTANCE_MODULE: 'workers', PENDING_WORKER_ENABLED: 'true', LOG_LEVEL: 'error', DB_POOL_MAX: '10' }),
  ),
);
const post = (i: number, path: string, body: unknown, headers: Record<string, string> = {}) =>
  instances[i % instances.length]!.post(path, body, headers);

log(`creating ${CFG.wallets} cold wallets + 1 hot wallet…`);
interface W { walletId: string; playerId: string }
const createWallet = async (i: number, amount: string): Promise<W> => {
  const res = await post(i, '/wallets', { playerId: crypto.randomUUID(), initialBalance: { amount, currency: 'BRL' } });
  if (res.status !== 201) throw new Error(`wallet: ${res.status}`);
  return { walletId: res.body.id, playerId: res.body.playerId };
};
const cold: W[] = [];
for (let i = 0; i < CFG.wallets; i += 20) cold.push(...(await Promise.all(Array.from({ length: Math.min(20, CFG.wallets - i) }, (_, j) => createWallet(i + j, '1000.00')))));
const hot = await createWallet(0, '100000000.00');

// ------------------------------------------------------------------ outbox publisher
let publisher: EventPublisher | undefined;
if (CFG.outbox === 'file') publisher = new FilePublisher(join(mkdtempSync(join(tmpdir(), 'load-')), 'events.jsonl'), 'load');
if (CFG.outbox === 'sqs') {
  const sqs = createSqsClient(env);
  publisher = new SqsEventPublisher(sqs, (await resolveQueueUrls(sqs, env)).events);
}
const outbox = publisher
  ? new OutboxPublisher(new MikroOutboxStore(orm), publisher, systemClock, new PromMetrics(), new JsonLogger({ level: 'error' }), noFaults, {
      ...DEFAULT_OUTBOX_PUBLISHER_CONFIG, owner: 'load-publisher', batchSize: 200, pollIntervalMs: 20,
    })
  : undefined;

// ------------------------------------------------------------------ workload
type Op = 'bet' | 'win' | 'hot_bet' | 'loss' | 'refund' | 'overdraft' | 'replay';
const HOT_WEIGHT = num('LOAD_HOT_WEIGHT', 12);
const MIX: [Op, number][] = ([['bet', 50], ['win', 15], ['hot_bet', HOT_WEIGHT], ['loss', 5], ['refund', 5], ['overdraft', 3], ['replay', 10]] as [Op, number][]).filter(([, w]) => w > 0);
const totalWeight = MIX.reduce((a, [, w]) => a + w, 0);
const pickOp = (): Op => {
  let r = Math.random() * totalWeight;
  for (const [op, w] of MIX) if ((r -= w) < 0) return op;
  return 'bet';
};
const rand = <T>(xs: T[]) => xs[Math.floor(Math.random() * xs.length)]!;
const amount = (min: number, max: number) => (Math.round((min + Math.random() * (max - min)) * 100) / 100).toFixed(2);

interface Req { body: Record<string, unknown>; key: string }
const recent: Req[] = []; // para replays
const appliedBets: { w: W; ext: string; amount: string }[] = []; // para REFUNDs
const make = (w: W, kind: string, amt: string, extra: Record<string, unknown> = {}): Req => {
  const ext = `ld-${Bun.randomUUIDv7()}`;
  return {
    key: `provider-a:${ext}`,
    body: { providerId: 'provider-a', externalTransactionId: ext, playerId: w.playerId, walletId: w.walletId, roundId: `r-${ext.slice(-6)}`, gameId: 'fortune-chimp', kind, money: { amount: amt, currency: 'BRL' }, ...extra },
  };
};
const build = (op: Op): { req: Req; expected: number[]; onOk?: (status: number) => void } => {
  switch (op) {
    case 'bet': {
      const w = rand(cold);
      const req = make(w, 'BET', amount(0.5, 5));
      return { req, expected: [201, 422], onOk: (s) => s === 201 && appliedBets.push({ w, ext: req.body.externalTransactionId as string, amount: (req.body.money as { amount: string }).amount }) };
    }
    case 'win': return { req: make(rand(cold), 'WIN', amount(0.5, 8)), expected: [201] };
    case 'hot_bet': return { req: make(hot, 'BET', amount(0.5, 5)), expected: [201] };
    case 'loss': return { req: make(rand(cold), 'LOSS', '0.00'), expected: [201] };
    case 'overdraft': return { req: make(rand(cold), 'BET', '999999.00'), expected: [422] };
    case 'refund': {
      const target = appliedBets.splice(Math.floor(Math.random() * appliedBets.length), 1)[0];
      if (!target) return build('bet');
      const req = make(target.w, 'REFUND', target.amount, { referenceExternalTransactionId: target.ext });
      // mesma rodada da BET (regra de referência)
      req.body.roundId = `r-${target.ext.slice(-6)}`;
      return { req, expected: [201] };
    }
    case 'replay': {
      const prev = recent.length ? rand(recent) : undefined;
      if (!prev) return build('bet');
      return { req: prev, expected: [200, 422, 202] };
    }
  }
};

interface Sample { op: Op; ms: number; status: number; ok: boolean; at: number }
const samples: Sample[] = [];
let networkErrors = 0;
let stopAt = 0;
let measureFrom = 0;
let rr = 0;

async function client(): Promise<void> {
  while (Date.now() < stopAt) {
    const op = pickOp();
    const { req, expected, onOk } = build(op);
    const started = performance.now();
    let status = 0;
    try {
      const res = await post(rr++, '/wagering/transactions', req.body, { 'idempotency-key': req.key });
      status = res.status;
    } catch {
      networkErrors++;
    }
    const ms = performance.now() - started;
    const ok = expected.includes(status);
    if (ok) onOk?.(status);
    if (op !== 'replay' && status) {
      recent.push(req);
      if (recent.length > 2_000) recent.shift();
    }
    if (Date.now() >= measureFrom) samples.push({ op, ms, status, ok, at: Date.now() });
  }
}

// amostragem do outbox lag (no banco: idade da mensagem pendente mais antiga)
const lagSamples: number[] = [];
let sampling = true;
const lagSampler = (async () => {
  while (sampling) {
    const [row] = (await conn.execute(
      `select coalesce(extract(epoch from (now() - min(occurred_at))), 0)::float8 as lag, count(*)::int as pending
         from outbox_messages where published_at is null`,
    )) as { lag: number; pending: number }[];
    if (Date.now() >= measureFrom) lagSamples.push(Math.max(0, Number(row!.lag)));
    await Bun.sleep(500);
  }
})();

const metricsSum = async (name: string, filter = '') => {
  let total = 0;
  for (const inst of instances) {
    const text = await (await fetch(`${inst.url}/metrics`)).text();
    for (const line of text.split('\n')) {
      const m = line.match(new RegExp(`^${name}(\\{[^}]*\\})? (\\S+)$`));
      if (m && (m[1] ?? '').includes(filter)) total += Number(m[2]);
    }
  }
  return total;
};

// ------------------------------------------------------------------ run
log(`warm-up ${CFG.warmupS}s + measure ${CFG.durationS}s, ${CFG.concurrency} clients, ${CFG.instances} instances, outbox=${CFG.outbox}`);
outbox?.start();
const before = {
  lock: await metricsSum('db_lock_conflicts_total'),
  retries: await metricsSum('db_transaction_retries_total'),
  replays: await metricsSum('idempotent_replays_total'),
};
measureFrom = Date.now() + CFG.warmupS * 1_000;
stopAt = measureFrom + CFG.durationS * 1_000;
await Promise.all(Array.from({ length: CFG.concurrency }, client));
const measuredS = (Math.max(...samples.map((s) => s.at)) - measureFrom) / 1_000;
const after = {
  lock: await metricsSum('db_lock_conflicts_total'),
  retries: await metricsSum('db_transaction_retries_total'),
  replays: await metricsSum('idempotent_replays_total'),
};

// drena a outbox e as pendentes
const drainStart = Date.now();
for (let i = 0; i < 600; i++) {
  const [r] = (await conn.execute(`select count(*)::int as n from outbox_messages where published_at is null`)) as { n: number }[];
  if (!outbox || r!.n === 0) break;
  await Bun.sleep(100);
}
const drainMs = Date.now() - drainStart;
sampling = false;
await lagSampler;
await outbox?.stop();

// ------------------------------------------------------------------ invariantes
const [inv] = (await conn.execute(
  `select
     (select count(*) from (
        select w.id from wallets w left join wallet_ledger_entries e on e.wallet_id = w.id
        group by w.id, w.balance_amount
        having w.balance_amount <> coalesce(sum(case e.direction when 'CREDIT' then e.amount else -e.amount end), 0)) x)::int as inconsistent_wallets,
     (select count(*) from wallets where balance_amount < 0)::int as negative_wallets,
     (select count(*) from wager_transactions where kind <> 'OPENING')::int as transactions,
     (select count(distinct idempotency_key) from wager_transactions where kind <> 'OPENING')::int as distinct_keys,
     (select count(*) from wager_transactions where status in ('PENDING','PENDING_REFERENCE'))::int as unresolved,
     (select count(*) from outbox_messages where published_at is null)::int as unpublished,
     (select count(*) from wallet_ledger_entries)::int as ledger_entries`,
)) as Record<string, number>[];
await stopInstances(instances);
await orm.close(true);

// ------------------------------------------------------------------ relatório
const pct = (xs: number[], p: number) => {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.ceil((p / 100) * s.length) - 1)]!;
};
const f = (n: number, d = 1) => n.toFixed(d);
const total = samples.length;
const failed = samples.filter((s) => !s.ok).length;
const by = (op?: Op) => (op ? samples.filter((s) => s.op === op) : samples);
const row = (label: string, xs: Sample[]) => {
  const ms = xs.map((s) => s.ms);
  return `| ${label} | ${xs.length} | ${f(xs.length / measuredS)} | ${f(pct(ms, 50))} | ${f(pct(ms, 95))} | ${f(pct(ms, 99))} | ${f(Math.max(0, ...ms))} | ${xs.length ? f((100 * xs.filter((s) => !s.ok).length) / xs.length, 2) : '0.00'}% |`;
};
const statusCounts = Object.entries(samples.reduce<Record<string, number>>((acc, s) => ((acc[s.status || 'net-error'] = (acc[s.status || 'net-error'] ?? 0) + 1), acc), {}))
  .sort()
  .map(([k, v]) => `${k}: ${v}`)
  .join(' · ');

const report = `# Resultado do teste de carga

> Gerado por \`bun run test:load\` em ${new Date().toISOString()}. Metodologia e análise: [LOAD_TEST.md](../LOAD_TEST.md).

## Ambiente
| | |
|---|---|
| SO / arquitetura | ${osType()} ${osRelease()} / ${arch()} |
| CPUs / memória | ${cpus().length} vCPU · ${f(totalmem() / 2 ** 30)} GiB |
| Runtime | Bun ${Bun.version} |
| Banco | ${pgVersion} (max_connections ${maxConn}) |
| Gerador de carga | mesmo host, \`fetch\` com keep-alive, loop fechado |

## Parâmetros
| instâncias | clientes concorrentes | aquecimento | medição | wallets frias | outbox |
|---|---|---|---|---|---|
| ${CFG.instances} (pool 10 cada) | ${CFG.concurrency} | ${CFG.warmupS} s | ${f(measuredS)} s | ${CFG.wallets} + 1 quente | ${CFG.outbox} |

Mix (pesos): ${MIX.map(([op, w]) => `${op} ${w}`).join(', ')}.

## Resultados (janela de medição)
| operação | requisições | req/s | p50 ms | p95 ms | p99 ms | máx ms | erro |
|---|---|---|---|---|---|---|---|
${row('**total**', by())}
${(['bet', 'win', 'hot_bet', 'loss', 'refund', 'overdraft', 'replay'] as Op[]).map((op) => row(op, by(op))).join('\n')}

- **Status HTTP:** ${statusCounts}
- **Taxa de erro** (resposta fora do esperado para a operação, 5xx ou falha de rede): **${f((100 * failed) / Math.max(total, 1), 3)}%** (${failed}/${total}; rede: ${networkErrors})
- **Conflitos de concorrência:** lock timeouts/deadlocks = ${after.lock - before.lock}; transações re-tentadas = ${after.retries - before.retries}; replays idempotentes atendidos = ${after.replays - before.replays}
- **Outbox lag** (amostrado a cada 500 ms): p50 ${f(pct(lagSamples, 50), 3)} s · p95 ${f(pct(lagSamples, 95), 3)} s · máx ${f(Math.max(0, ...lagSamples), 3)} s · drenagem final ${drainMs} ms

## Invariantes ao final
| verificação | resultado |
|---|---|
| wallets com saldo ≠ ledger | ${inv!.inconsistent_wallets} |
| wallets com saldo negativo | ${inv!.negative_wallets} |
| transações × idempotency keys distintas | ${inv!.transactions} × ${inv!.distinct_keys} |
| transações não resolvidas (PENDING*) | ${inv!.unresolved} |
| eventos não publicados | ${inv!.unpublished}${CFG.outbox === 'none' ? ' (publisher desligado)' : ''} |
| lançamentos no ledger | ${inv!.ledger_entries} |
`;
mkdirSync(dirname(CFG.report), { recursive: true });
writeFileSync(CFG.report, report);
console.log(report);
const okInvariants = inv!.inconsistent_wallets === 0 && inv!.negative_wallets === 0 && inv!.transactions === inv!.distinct_keys && inv!.unresolved === 0;
if (!okInvariants) {
  log('INVARIANT VIOLATION');
  process.exit(1);
}
process.exit(0);
