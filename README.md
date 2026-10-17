# Distributed Wagering Processor

Serviço financeiro distribuído que processa transações de apostas — `BET`, `WIN`, `LOSS`, `REFUND`,
`ROLLBACK` — recebidas de múltiplos provedores por **HTTP** e por **SQS**, e permanece correto com
mensagens duplicadas, fora de ordem, concorrentes, com várias instâncias e com processos morrendo
em qualquer ponto.

- **Decisões, trade-offs e limitações:** [`ARCHITECTURE.md`](ARCHITECTURE.md)
- Plano original: [`docs/PLAN.md`](docs/PLAN.md)

**Stack:** Bun 1.2+ · TypeScript strict · NestJS 11 · MikroORM 6 + PostgreSQL 17 · AWS SQS FIFO
(LocalStack) · Docker Compose · Prometheus (`prom-client`) · zod · big.js

---

## Pré-requisitos

- [Bun](https://bun.sh) ≥ 1.2 — `curl -fsSL https://bun.sh/install | bash`
- Docker com Compose v2

## Setup rápido

```bash
bun install
cp .env.example .env
bun run infra:up        # PostgreSQL + LocalStack (cria filas FIFO, DLQ e redrive)
bun run migrate         # aplica as migrations no banco de dev
bun run dev             # API + consumidor SQS + publisher da outbox + worker de pendentes
curl -s localhost:3000/health/ready
```

### Tudo em containers, com 3 instâncias

```bash
docker compose --profile app up --build --scale app=3
# instâncias em http://localhost:3000, :3001 e :3002 — todas consomem a mesma fila e a mesma outbox
```

## Comandos

| Comando | O que faz |
|---|---|
| `bun run dev` / `bun run start` | sobe a aplicação (watch / normal) |
| `bun run migrate` · `migrate:down` · `migrate:status` | migrations (reversíveis) |
| `bun run typecheck` | `tsc --noEmit` em modo strict |
| `bun test` | todas as suítes (requer `infra:up`) |
| `bun run test:unit` | domínio e utilitários (sem infra) |
| `bun run test:integration` | PostgreSQL real (+ SQS real nas suítes `*-sqs`) |
| `bun run test:concurrency` | paralelismo real, 3 processos, reinício com SIGKILL/SIGTERM |
| `bun run test:sqs` | só as suítes que exigem a LocalStack |
| `bun run test:auth` | autenticação OIDC (JWKS real; Keycloak real se `auth:up`) |
| `bun run test:load` | teste de carga com relatório em `docs/load-test-results/` ([metodologia e análise](docs/LOAD_TEST.md)) |
| `bun run infra:up` / `infra:down` | sobe / derruba a infra (o `down` apaga volumes) |
| `bun run auth:up` | sobe o Keycloak (profile `auth`) |

### Testes

Nenhuma suíte de integração substitui PostgreSQL ou SQS por mocks. Os testes usam o banco
`wagering_test` e as filas `*-test.fifo`, criados pelo compose; as variáveis vêm de `.env.test`
(carregado automaticamente pelo `bun test`). O preload `test/setup.ts` recusa rodar se o banco não
for `*_test`. As suítes que precisam de SQS real são **puladas com aviso** se a LocalStack não
estiver no ar. O mapa requisito → teste está em `ARCHITECTURE.md` §11.

Todas as suítes terminam verificando o invariante `wallet.balance == saldo reconstruído pelo ledger`.

---

## API

Erros sempre no formato `{"error": {"code", "message", "details?"}}`. Todas as respostas trazem
`X-Correlation-Id` (o recebido ou um gerado). `/health/*` e `/metrics` não exigem autenticação.

### Wallets

```bash
# criar (saldo inicial > 0 gera transação OPENING + lançamento CREDIT na mesma transação SQL)
curl -s -X POST localhost:3000/wallets -H 'content-type: application/json' \
  -d '{"playerId":"0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1","initialBalance":{"amount":"1000.00","currency":"BRL"}}'
# → 201 {"id":"…","playerId":"…","balance":{"amount":"1000.00","currency":"BRL"},"version":1,…}
# → 409 WALLET_ALREADY_EXISTS para o mesmo playerId + currency

curl -s localhost:3000/wallets/<walletId>
curl -s 'localhost:3000/wallets/<walletId>/ledger?limit=50'        # próxima página: &cursor=<nextCursor>
curl -s -X POST localhost:3000/wallets/<walletId>/reconciliation  # nunca corrige; sinaliza e contabiliza
```

### Transações

```bash
curl -s -X POST localhost:3000/wagering/transactions -H 'content-type: application/json' \
  -H 'Idempotency-Key: provider-a:transaction-123' \
  -d '{"providerId":"provider-a","externalTransactionId":"transaction-123","playerId":"<playerId>",
       "walletId":"<walletId>","roundId":"round-987","gameId":"fortune-chimp","kind":"BET",
       "money":{"amount":"25.00","currency":"BRL"}}'
# → 201 {"transactionId":"…","status":"PROCESSED","balance":{"amount":"975.00","currency":"BRL"},"idempotentReplay":false}

curl -s localhost:3000/wagering/transactions/<transactionId>
curl -s localhost:3000/providers/provider-a/wagering/transactions/transaction-123
```

`REFUND` e `ROLLBACK` exigem `referenceExternalTransactionId`; `WIN`/`LOSS` podem referenciar a `BET`.

| Status | Significado | O provedor deve |
|---|---|---|
| 201 | aplicada agora | — |
| 200 | replay de uma aplicada (`idempotentReplay: true`, saldo da época) | — |
| 202 | `PENDING_REFERENCE` — aguardando a transação referenciada | consultar depois |
| 422 | `REJECTED`, com `failureCode` | agir conforme o código (`ARCHITECTURE.md` §1) |
| 400 | payload/header inválido | corrigir |
| 409 | mesma `Idempotency-Key` com outro payload, ou `externalTransactionId` reutilizado | não reenviar com essa chave |
| 503 | falha transitória (`Retry-After`) | reenviar **a mesma** requisição |

### Pela fila

```bash
aws --endpoint-url http://localhost:4566 sqs send-message \
  --queue-url http://localhost:4566/000000000000/wager-transactions.fifo \
  --message-group-id <walletId> --message-deduplication-id msg-123 \
  --message-body '{"messageId":"msg-123","type":"WagerTransactionRequested","occurredAt":"2026-07-29T15:00:00.000Z",
    "data":{"providerId":"provider-a","externalTransactionId":"transaction-123","idempotencyKey":"provider-a:transaction-123",
    "playerId":"<playerId>","walletId":"<walletId>","roundId":"round-987","gameId":"fortune-chimp","kind":"BET",
    "money":{"amount":"25.00","currency":"BRL"}}}'
```

| Fila | Uso |
|---|---|
| `wager-transactions.fifo` | entrada (`MessageGroupId = walletId`) |
| `wager-transactions-dlq.fifo` | mensagens permanentes ou que esgotaram 5 entregas (`failureReason` nos atributos) |
| `wallet-events.fifo` | eventos de integração publicados pela outbox (`MessageDeduplicationId = eventId`) |

Eventos: `WagerTransactionProcessed`, `WagerTransactionRejected`, `WagerTransactionPendingReference`,
`WalletBalanceChanged`. Consumidores devem deduplicar por `eventId` e ordenar por `walletVersion`.

---

## Autenticação (opcional)

Desligada por padrão (`AUTH_MODE=none`). Com Keycloak:

```bash
bun run auth:up                                   # Keycloak + realm "wagering" (provider-a, provider-b)
AUTH_MODE=oidc OIDC_ISSUER=http://localhost:8080/realms/wagering bun run dev

TOKEN=$(curl -s -X POST localhost:8080/realms/wagering/protocol/openid-connect/token \
  -d grant_type=client_credentials -d client_id=provider-a -d client_secret=provider-a-secret | jq -r .access_token)
curl -s -H "Authorization: Bearer $TOKEN" localhost:3000/wallets/<walletId>
```
Sem token ou com token inválido → 401; operar em nome de outro `providerId` → 403. Em containers:
`AUTH_MODE=oidc docker compose --profile auth --profile app up`. Detalhes em `ARCHITECTURE.md` §9.

## Teste de carga

`bun run test:load` sobe 3 instâncias, gera 30 s de tráfego misto (incluindo uma wallet disputada
e replays) com um publisher de outbox real em paralelo, e reporta throughput, p50/p95/p99, taxa de
erro, conflitos de concorrência e outbox lag, verificando as invariantes ao final. Metodologia,
resultados e análise: [`docs/LOAD_TEST.md`](docs/LOAD_TEST.md).

## Observabilidade

- **Logs:** JSON, uma linha por evento, com `correlationId`, `messageId`, `transactionId`,
  `walletId` e `providerId` propagados automaticamente. Valores monetários e payloads são
  redigidos. Nível via `LOG_LEVEL`.
- **Métricas:** `GET /metrics` (Prometheus) — transações por status, duplicatas, retries, DLQ,
  conflitos de lock, outbox lag, latência de processamento e HTTP. Lista completa em
  `ARCHITECTURE.md` §8.
- **Health:** `GET /health/live` (processo) e `GET /health/ready` (PostgreSQL + SQS; 503 se algum falhar).

## Configuração

Principais variáveis (todas com default; ver `src/config/env.ts` e `.env.example`):

| Variável | Default | |
|---|---|---|
| `DATABASE_URL` | — | PostgreSQL |
| `DB_POOL_MAX` · `DB_LOCK_TIMEOUT_MS` · `DB_STATEMENT_TIMEOUT_MS` | 10 · 2000 · 5000 | pool e timeouts por transação |
| `SQS_ENDPOINT` · `WAGER_QUEUE_NAME` · `WAGER_DLQ_NAME` · `EVENTS_QUEUE_NAME` | LocalStack | filas |
| `CONSUMER_ENABLED` · `CONSUMER_VISIBILITY_TIMEOUT_S` · `CONSUMER_MAX_RECEIVES` | true · 30 · 5 | consumidor |
| `OUTBOX_PUBLISHER_ENABLED` · `OUTBOX_LEASE_MS` · `OUTBOX_BATCH_SIZE` | true · 30000 · 50 | publisher |
| `PENDING_WORKER_ENABLED` · `PENDING_WORKER_POLL_INTERVAL_MS` | true · 500 | worker de pendentes |
| `AUTH_MODE` · `OIDC_ISSUER` · `OIDC_AUDIENCE` · `OIDC_JWKS_URI` | `none` · — · `wagering-api` · `<issuer>/protocol/openid-connect/certs` | autenticação (§9) |
| `LOG_LEVEL` · `INSTANCE_ID` | info · hostname-pid | |
| `FAULTS` | — | injeção de falhas para testes (recusado em produção) |

## Estrutura

```
src/
  shared/            domínio compartilhado (Money, erros), portas da aplicação, eventos
  modules/
    wallet/          domain · application · infrastructure · interface/http
    wagering/        domain (regras, settle) · application (use case, worker) · interface (http, sqs)
    messaging/       inbox/outbox (domínio, publisher, SQS)
    auth/            guard + validação OIDC (JWKS)
  infrastructure/    MikroORM (UnitOfWork, config), SQS, observabilidade
  interface/http/    filtro de erros, middleware de contexto, validação
migrations/          SQL versionado e reversível (constraints, triggers)
scripts/             migrate, load-test
docker/              init do Postgres e da LocalStack, realm do Keycloak
test/                unit · integration · concurrency · spike · helpers
```

## Solução de problemas

- **LocalStack pede `LOCALSTACK_AUTH_TOKEN`:** as tags mais recentes passaram a exigir conta. O
  compose fixa uma tag 4.x anterior; se ainda pedir token, use uma tag mais antiga ou o MiniStack
  (o init script usa só a API SQS padrão).
- **Porta 5432/4566 ocupada:** pare o serviço local ou ajuste `ports` no compose e o `.env`.
- **Suítes `*-sqs` puladas:** a LocalStack não está acessível — `bun run infra:up`.
