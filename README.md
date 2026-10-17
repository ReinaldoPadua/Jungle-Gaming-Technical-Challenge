# Distributed Wagering Processor

Serviço financeiro distribuído que processa transações de apostas (BET / WIN / LOSS / REFUND / ROLLBACK)
vindas de múltiplos provedores, via HTTP e SQS, com idempotência persistente, ledger imutável e
transactional outbox.

> Status: **fases 0–8** (fundação, domínio, schema, API de wallet, processamento de transações, outbox, consumidor SQS, worker de referências pendentes, observabilidade). Veja o plano completo em [`docs/PLAN.md`](docs/PLAN.md).
> Decisões técnicas serão consolidadas em `ARCHITECTURE.md`.

## Stack

Bun 1.2+ · TypeScript strict · NestJS 11 · MikroORM 6 (PostgreSQL) · AWS SQS (LocalStack) · Docker Compose

## Pré-requisitos

- [Bun](https://bun.sh) ≥ 1.2 (`curl -fsSL https://bun.sh/install | bash`)
- Docker com Docker Compose v2

## Setup rápido

```bash
bun install
cp .env.example .env          # valores padrão já apontam para o compose
bun run infra:up              # postgres + localstack (cria as filas FIFO e a DLQ)
bun run migrate               # aplica migrations no banco de dev
bun run dev                   # http://localhost:3000/health/ready
```

## Rodar a aplicação inteira em containers (3 instâncias)

```bash
docker compose --profile app up --build --scale app=3
# instâncias em http://localhost:3000, :3001 e :3002
```

## Comandos

| Comando | O que faz |
|---|---|
| `bun run dev` / `bun run start` | sobe a API (watch / normal) |
| `bun run migrate` / `migrate:down` / `migrate:status` | migrations (programáticas, reversíveis) |
| `bun run typecheck` | `tsc --noEmit` em modo strict |
| `bun test` | todas as suítes (requer `infra:up`) |
| `bun run test:spike` | validações da fase 0 (Bun × Nest × MikroORM × SQS) |
| `bun run test:unit` / `test:integration` / `test:concurrency` | suítes por tipo |
| `bun run infra:down` | derruba a infra e apaga os volumes |

Os testes usam **PostgreSQL e LocalStack reais**. Suítes que dependem do SQS são puladas com aviso
explícito se a LocalStack não estiver no ar — banco `wagering_test` e filas `*-test.fifo`
(criados automaticamente pelo compose). As variáveis vêm de `.env.test`, que o Bun carrega sozinho
em `bun test`. O preload `test/setup.ts` recusa rodar se `DATABASE_URL` não apontar para um banco `*_test`.

## API

```bash
# criar wallet (saldo inicial gera transação OPENING + lançamento no ledger)
curl -s -X POST localhost:3000/wallets -H 'content-type: application/json' \
  -d '{"playerId":"0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1","initialBalance":{"amount":"1000.00","currency":"BRL"}}'

curl -s localhost:3000/wallets/<walletId>
curl -s 'localhost:3000/wallets/<walletId>/ledger?limit=50'           # próxima página: &cursor=<nextCursor>
curl -s -X POST localhost:3000/wallets/<walletId>/reconciliation
curl -s localhost:3000/metrics

# submeter transação (Idempotency-Key obrigatório)
curl -s -X POST localhost:3000/wagering/transactions -H 'content-type: application/json' \
  -H 'Idempotency-Key: provider-a:transaction-123' \
  -d '{"providerId":"provider-a","externalTransactionId":"transaction-123","playerId":"<playerId>",
       "walletId":"<walletId>","roundId":"round-987","gameId":"fortune-chimp","kind":"BET",
       "money":{"amount":"25.00","currency":"BRL"}}'

curl -s localhost:3000/wagering/transactions/<transactionId>
curl -s localhost:3000/providers/provider-a/wagering/transactions/transaction-123
```

Status de `POST /wagering/transactions`: 201 aplicada · 200 replay · 202 aguardando referência ·
422 rejeitada (com `failureCode`) · 400 inválida · 409 conflito de idempotência · 503 transitório.

Erros seguem sempre `{"error":{"code","message","details?"}}` — ver `ARCHITECTURE.md` §3.

## Filas

| Fila | Uso |
|---|---|
| `wager-transactions.fifo` | entrada de transações (`MessageGroupId = walletId`) |
| `wager-transactions-dlq.fifo` | DLQ — redrive com `maxReceiveCount = 5` |
| `wallet-events.fifo` | eventos de integração publicados pela outbox (`MessageGroupId = walletId`, dedup por `eventId`) |

## Enviando transações pela fila

```bash
aws --endpoint-url http://localhost:4566 sqs send-message \
  --queue-url http://localhost:4566/000000000000/wager-transactions.fifo \
  --message-group-id <walletId> --message-deduplication-id msg-123 \
  --message-body '{"messageId":"msg-123","type":"WagerTransactionRequested","occurredAt":"2026-07-29T15:00:00.000Z",
    "data":{"providerId":"provider-a","externalTransactionId":"transaction-123","idempotencyKey":"provider-a:transaction-123",
    "playerId":"<playerId>","walletId":"<walletId>","roundId":"round-987","gameId":"fortune-chimp","kind":"BET",
    "money":{"amount":"25.00","currency":"BRL"}}}'
```

O consumidor sobe junto com a API (`CONSUMER_ENABLED=true`). Mensagens inválidas vão para
`wager-transactions-dlq.fifo` com o motivo em `failureReason`.

## Solução de problemas

- **LocalStack pede `LOCALSTACK_AUTH_TOKEN`**: as tags mais recentes da LocalStack passaram a exigir
  conta. O compose fixa uma tag 4.x antiga; se ainda assim pedir token, troque a imagem por uma
  versão anterior ou pelo MiniStack (também aceito pelo desafio) — o init script usa só a API SQS padrão.
- **Porta 5432/4566 ocupada**: pare o Postgres/LocalStack local ou ajuste `ports` no compose e o `.env`.
