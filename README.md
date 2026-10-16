# Distributed Wagering Processor

Serviço financeiro distribuído que processa transações de apostas (BET / WIN / LOSS / REFUND / ROLLBACK)
vindas de múltiplos provedores, via HTTP e SQS, com idempotência persistente, ledger imutável e
transactional outbox.

> Status: **fase 0 (fundação)**. Veja o plano completo em [`docs/PLAN.md`](docs/PLAN.md).
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

Os testes usam **PostgreSQL e LocalStack reais**: banco `wagering_test` e filas `*-test.fifo`
(criados automaticamente pelo compose). As variáveis vêm de `.env.test`, que o Bun carrega sozinho
em `bun test`. O preload `test/setup.ts` recusa rodar se `DATABASE_URL` não apontar para um banco `*_test`.

## Filas

| Fila | Uso |
|---|---|
| `wager-transactions.fifo` | entrada de transações (`MessageGroupId = walletId`) |
| `wager-transactions-dlq.fifo` | DLQ — redrive com `maxReceiveCount = 5` |
| `wallet-events.fifo` | eventos de integração publicados pela outbox |

## Solução de problemas

- **LocalStack pede `LOCALSTACK_AUTH_TOKEN`**: as tags mais recentes da LocalStack passaram a exigir
  conta. O compose fixa uma tag 4.x antiga; se ainda assim pedir token, troque a imagem por uma
  versão anterior ou pelo MiniStack (também aceito pelo desafio) — o init script usa só a API SQS padrão.
- **Porta 5432/4566 ocupada**: pare o Postgres/LocalStack local ou ajuste `ports` no compose e o `.env`.
