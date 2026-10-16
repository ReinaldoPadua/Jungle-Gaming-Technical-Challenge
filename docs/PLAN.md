# Plano de implementação — Distributed Wagering Processor

> Objetivo: maximizar os 85 pontos "duros" (correção, concorrência, idempotência, mensageria, testes) antes de qualquer polimento. Autenticação fica por último (0 pontos).

---

## 0. Princípios que guiam todas as decisões

1. **O banco é o árbitro final.** Toda invariante crítica (unicidade, saldo ≥ 0, imutabilidade do ledger, reversão única, aritmética do lançamento) tem constraint/trigger no PostgreSQL. O código de aplicação é a primeira linha de defesa, o schema é a última.
2. **Uma transação SQL por operação financeira**: inbox + wager_transaction + wallet + ledger + outbox, tudo ou nada.
3. **Lock por wallet, nunca global.** `SELECT … FOR UPDATE` na linha da wallet.
4. **Insert-first para idempotência**: tentar inserir e deixar a unique constraint decidir quem ganhou; nunca "consultar e depois inserir".
5. **Domínio puro**: sem decorators de Nest/MikroORM no domínio. Mapeamento via `EntitySchema` na infraestrutura.

---

## 1. Decisões técnicas (vão para o ARCHITECTURE.md)

| Tema | Decisão | Justificativa curta |
|---|---|---|
| ORM | **MikroORM 6** + `@mikro-orm/postgresql` + `@mikro-orm/migrations` | preferencial; `em.transactional()`, `LockMode.PESSIMISTIC_WRITE`, Unit of Work explícito |
| Mapeamento | `EntitySchema` (sem decorators) | domínio independente do ORM; `rehydrate` usado no hydrate customizado/repositório |
| Money | `big.js` (ou `decimal.js`) no domínio; coluna `numeric(20,2)` + `char(3)` currency; MikroORM `decimal` retorna **string** | exato, sem `number` em nenhum ponto do fluxo |
| Concorrência | **Pessimistic lock** (`FOR UPDATE`) na wallet + `version` incrementado + `CHECK (balance >= 0)` | hot wallet serializa sem storm de retry; optimistic exigiria retry agressivo no cenário "50 em paralelo". `lock_timeout` curto + retry limitado em `40P01`/`55P03` |
| Idempotência | `UNIQUE(idempotency_key)` e `UNIQUE(provider_id, external_transaction_id)` em `wager_transactions`; `payload_hash` SHA-256 de JSON canônico | persistente, multi-instância, à prova de race |
| Snapshot de resposta | colunas `result_balance_amount/currency` na transação | regra 7.7: replay devolve o saldo observado na época |
| Inbox | PK `(consumer_name, message_id)` | dedup de mensagem SQS |
| Outbox | tabela + worker com `FOR UPDATE SKIP LOCKED` + lease (`locked_until`) | múltiplos publishers sem duplicação indefinida; crash → lease expira → outra instância assume |
| Broker | SQS FIFO, `MessageGroupId = walletId`, `MessageDeduplicationId = messageId` | **otimização** (ordem por wallet, menos contenção); correção não depende disso |
| Eventos publicados | fila `wallet-events.fifo` (ou SNS→SQS) com `MessageDeduplicationId = eventId` | consumidor deduplica por `eventId` |
| Logs | `nestjs-pino` + `AsyncLocalStorage` para contexto | JSON estruturado com correlationId etc. |
| Métricas | `prom-client`, `GET /metrics` | barato, padrão |
| Auth | Porta `ProviderIdentityPort` + `AuthGuard`; implementação Keycloak (client credentials, JWT via JWKS com `jose`) **só se sobrar tempo** | 0 pontos; claim `provider_id` do token deve bater com `body.providerId` |
| IDs | UUID v7 (`uuidv7` ou `Bun.randomUUIDv7()`) | ordenável, bom para cursor do ledger |
| Testes | `bun test` + Postgres/LocalStack reais via `docker compose` (profile `test`) | exigência: sem mocks de infra |

### Riscos técnicos a validar no Dia 1 (spike)
- NestJS rodando sob Bun com `emitDecoratorMetadata` (Bun suporta via tsconfig, mas validar DI + `reflect-metadata`).
- MikroORM CLI de migrations sob Bun (fallback: rodar migrator programaticamente via script `bun run migrate`).
- `@aws-sdk/client-sqs` contra LocalStack FIFO (redrive policy + `ChangeMessageVisibility`).
Se algo quebrar aqui, decidir cedo (ex.: TypeORM como fallback) em vez de descobrir no fim.

---

## 2. Estrutura do repositório

```
.
├── docker-compose.yml            # postgres, localstack, app x3 (profile multi), keycloak (profile auth)
├── docker/localstack/init.sh     # cria filas FIFO + DLQ + redrive policy
├── src/
│   ├── main.ts                   # bootstrap HTTP
│   ├── worker.ts                 # bootstrap só de workers (opcional; ou flags por env)
│   ├── shared/
│   │   ├── domain/money.ts, errors.ts, clock.ts, id-generator.ts
│   │   ├── events/integration-event.ts
│   │   ├── observability/ (logger, metrics, context ALS)
│   │   └── canonical-json.ts, payload-hash.ts
│   ├── modules/
│   │   ├── wallet/
│   │   │   ├── domain/ wallet.ts, wallet-ledger-entry.ts, ledger-direction.ts
│   │   │   ├── application/ open-wallet.use-case.ts, get-wallet, get-ledger, reconcile-wallet
│   │   │   ├── infrastructure/ schemas/*.schema.ts, mikro-wallet.repository.ts
│   │   │   └── interface/http/ wallets.controller.ts, dtos
│   │   ├── wagering/
│   │   │   ├── domain/ wager-transaction.ts, kinds, status, failure-code.ts, reversal-policy.ts
│   │   │   ├── application/ process-wager-transaction.use-case.ts, retry-pending-references.job.ts
│   │   │   ├── infrastructure/ repository, sqs-consumer.ts
│   │   │   └── interface/http/ wagering.controller.ts
│   │   └── messaging/
│   │       ├── domain/ inbox-message.ts, outbox-message.ts
│   │       ├── application/ outbox-publisher.worker.ts
│   │       └── infrastructure/ sqs.client.ts, outbox.repository.ts, inbox.repository.ts
│   └── health/
├── migrations/
├── test/
│   ├── unit/
│   ├── integration/
│   ├── concurrency/
│   ├── helpers/ (spawn de instâncias, fault injection, assertLedgerInvariant)
│   └── load/
├── README.md
└── ARCHITECTURE.md
```

Portas (interfaces em `application/ports`): `WalletRepository`, `WagerTransactionRepository`, `InboxRepository`, `OutboxRepository`, `UnitOfWork`, `MessagePublisher`, `Clock`, `IdGenerator`, `ProviderIdentityPort`, `Metrics`.

---

## 3. Schema do banco (coração da avaliação)

### `wallets`
- `id uuid PK`, `player_id uuid NOT NULL`, `currency char(3) NOT NULL CHECK (currency ~ '^[A-Z]{3}$')`
- `balance_amount numeric(20,2) NOT NULL CHECK (balance_amount >= 0)`
- `version int NOT NULL CHECK (version >= 1)`
- `created_at`, `updated_at timestamptz`
- `UNIQUE (player_id, currency)`

### `wager_transactions`
- `id uuid PK`, `provider_id text`, `external_transaction_id text`, `idempotency_key text`, `payload_hash char(64)`
- `wallet_id uuid FK`, `player_id`, `round_id`, `game_id`, `kind text CHECK (kind IN (...))`, `status text CHECK (...)`
- `amount numeric(20,2) CHECK (amount >= 0)` (> 0 exceto OPENING? decidir: aceitar `0.00`? → documentar; sugestão: BET/WIN/REFUND/ROLLBACK > 0, LOSS ≥ 0)
- `currency char(3)`
- `reference_external_transaction_id text NULL`, `reference_transaction_id uuid NULL FK self`
- `failure_code text NULL`, `result_balance_amount numeric(20,2) NULL`
- `attempts int`, `next_attempt_at timestamptz NULL` (para PENDING_REFERENCE), `correlation_id`
- `created_at`, `processed_at`
- `UNIQUE (idempotency_key)`; `UNIQUE (provider_id, external_transaction_id)`
- `CHECK (kind NOT IN ('REFUND','ROLLBACK') OR reference_external_transaction_id IS NOT NULL)`
- `CHECK ((status = 'REJECTED' OR status = 'FAILED') = (failure_code IS NOT NULL))`
- `CHECK (status <> 'PROCESSED' OR processed_at IS NOT NULL)`
- **Reversão única** (decidido na fase 1: uma transação só é revertida uma vez, por qualquer tipo): `CREATE UNIQUE INDEX ux_single_reversal ON wager_transactions (reference_transaction_id) WHERE status = 'PROCESSED' AND kind IN ('REFUND','ROLLBACK');`
- Trigger `trg_wager_tx_terminal_guard` (BEFORE UPDATE): bloqueia mudança se `OLD.status` ∈ terminais; bloqueia alteração de campos imutáveis (kind, amount, payload_hash…).
- Índice parcial para o worker: `(next_attempt_at) WHERE status = 'PENDING_REFERENCE'`.
- Índice `(provider_id, reference_external_transaction_id)` para achar dependentes.

### `wallet_ledger_entries`
- `id uuid PK`, `wallet_id FK`, `transaction_id FK`, `direction text CHECK IN ('DEBIT','CREDIT')`
- `amount numeric(20,2) CHECK (amount > 0)`, `currency`, `balance_before`, `balance_after` (ambos `CHECK >= 0`)
- `sequence bigint` (= wallet.version após aplicar) → `UNIQUE (wallet_id, sequence)` — garante ordem total por wallet e cursor estável
- `UNIQUE (transaction_id, wallet_id)` — no máximo 1 lançamento por transação/wallet
- `CHECK ((direction='CREDIT' AND balance_after = balance_before + amount) OR (direction='DEBIT' AND balance_after = balance_before - amount))`
- Trigger `BEFORE UPDATE OR DELETE` → `RAISE EXCEPTION` (append-only). Opcional: `REVOKE UPDATE, DELETE` do role da aplicação.

### (Diferencial) consistência saldo ↔ ledger no schema
Constraint trigger `DEFERRABLE INITIALLY DEFERRED` em `wallets` AFTER UPDATE: verifica que existe ledger com `wallet_id = NEW.id AND sequence = NEW.version AND balance_after = NEW.balance_amount`. Assim é impossível commitar mudança de saldo sem lançamento correspondente.

### `inbox_messages`
- `PK (consumer_name, message_id)`, `payload_hash`, `received_at`, `processed_at`

### `outbox_messages`
- `id uuid PK` (= eventId), `aggregate_id`, `event_type`, `payload jsonb`, `occurred_at`
- `attempts int`, `next_attempt_at`, `locked_until`, `locked_by`, `published_at`, `last_error`
- Índice parcial `(next_attempt_at) WHERE published_at IS NULL`

Todas as migrations com `up` e `down`. Teste de integração roda `up → down → up`.

---

## 4. Domínio

### Money
- Regex de entrada: `^(0|[1-9]\d*)(\.\d{1,2})?$` → normaliza para 2 casas; rejeita `NaN`, `Infinity`, `1e3`, `""`, `-1`, `1.234`, espaços.
- `from()` para contratos de entrada (não-negativo); `fromPersisted()`/`rehydrate` aceita o que veio do banco.
- `subtract` pode gerar negativo (o domínio da Wallet é quem proíbe); `toJSON` → `{ amount: "25.00", currency }`.
- `CurrencyMismatchError`, `InvalidMoneyError`.

### Wallet
- `open()` → version 1; se saldo inicial > 0 o use case cria `OPENING` + ledger CREDIT.
- `debit(money, transactionId, at)` / `credit(...)` → retornam `WalletLedgerEntry` (aplicam saldo + incrementam version + produzem lançamento juntos — impossível um sem o outro).
- `debit` lança `InsufficientFundsError` (o use case traduz para `failureCode` adequado conforme o kind).

### WagerTransaction — máquina de estados
```
            create()
               │
            PENDING ──► PROCESSED   (terminal)
               │  └───► REJECTED    (terminal)
               │  └───► FAILED      (terminal)
               ▼
       PENDING_REFERENCE ──► PROCESSED | REJECTED | FAILED
               ▲    │
               └────┘ (reagenda: attempts++, nextAttemptAt)
```
- `ledgerDirectionFor(reference)`: BET→DEBIT, WIN/REFUND/OPENING→CREDIT, ROLLBACK→inverso da direção da referência; LOSS → sem direção (`affectsBalance() = false`).

### ReversalPolicy (serviço de domínio)
Valida referência: mesmo provider/player/wallet/moeda/round; `REFUND` só → BET; `ROLLBACK` → BET|WIN|REFUND; referência `PROCESSED`; valor igual; não revertida antes pelo mesmo kind.

### FailureCode (taxonomia — documentar com "retryable?")
| Código | Origem | Provedor deve |
|---|---|---|
| `INSUFFICIENT_FUNDS` | BET sem saldo | desistir |
| `REVERSAL_WOULD_OVERDRAW` | ROLLBACK de WIN/REFUND sem saldo | escalar/manual |
| `CURRENCY_MISMATCH` | moeda ≠ wallet | corrigir payload |
| `WALLET_NOT_FOUND` / `WALLET_PLAYER_MISMATCH` | | corrigir |
| `REFERENCE_NOT_FOUND` | TTL esgotado | desistir/investigar |
| `REFERENCE_MISMATCH` | provider/player/round/wallet diferente | corrigir |
| `REFERENCE_INVALID_KIND` | REFUND→WIN etc. | corrigir |
| `REFERENCE_NOT_PROCESSED` | referência REJECTED | desistir |
| `REFERENCE_AMOUNT_MISMATCH` | valor ≠ | corrigir |
| `ALREADY_REVERSED` | segunda reversão do mesmo kind | desistir |
| `INFRA_PERMANENT_FAILURE` | FAILED | suporte |

Decisões a documentar: pode REFUND **e** ROLLBACK na mesma BET? (regra 4 diz "pelo mesmo tipo" → permitir, ou bloquear ambos? sugiro bloquear: BET reembolsada não pode sofrer rollback, evita crédito duplo — documentar como interpretação). WIN sem referência permitido; se tiver referência, validar.

---

## 5. Use case central: `ProcessWagerTransaction`

Entrada única para HTTP e SQS (`{ command, inbox?: { consumerName, messageId, payloadHash } }`).

```
em.transactional(async tx => {
  1. se inbox: INSERT inbox ON CONFLICT DO NOTHING
       → se já existia e processed: retorna resultado salvo da transação (replay)
  2. INSERT wager_transaction (PENDING) ON CONFLICT (idempotency_key) DO NOTHING RETURNING
       → conflito: SELECT existente
            payload_hash ≠ → IdempotencyConflictError (409)
            igual → replay (status + result_balance originais, idempotentReplay=true)
            (cobre também colisão em (provider_id, external_transaction_id) com key diferente → conflito)
  3. SELECT wallet FOR UPDATE   (lock por wallet; lock_timeout 2s)
  4. validar wallet (existe, player, moeda) → senão REJECT
  5. se requiresReference: buscar referência por (provider_id, reference_external_id)
       → ausente: markPendingReference, nextAttemptAt; outbox PendingReference; FIM
       → ReversalPolicy → violação: REJECT
  6. aplicar: wallet.debit/credit → ledger entry; LOSS → nada
       InsufficientFunds → REJECT (código conforme kind)
  7. markProcessed, result_balance = wallet.balance
  8. outbox: WagerTransactionProcessed | Rejected (+ WalletBalanceChanged se mudou)
  9. inbox.markProcessed
})  // commit
→ só então: ack SQS / resposta HTTP
```
- Ordem de lock: sempre wallet primeiro (antes de tocar referência) → evita deadlock.
- Corrida de 50 inserts idênticos: 1 ganha o INSERT, 49 caem no conflito; o `SELECT` do existente após o vencedor commitar retorna PROCESSED. Se o vencedor ainda não commitou, o `INSERT … ON CONFLICT` **espera** o lock da linha → naturalmente serializa. ✔
- Retry externo limitado (3x, jitter) para `40001`/`40P01`/`55P03`; métrica `lock_conflicts_total`.
- Fault injection por env (`FAULT=crash_after_commit_before_ack`) só ativa em teste.

### Retry de PENDING_REFERENCE
- Job (`@nestjs/schedule` ou loop próprio) a cada 1s: `SELECT … WHERE status='PENDING_REFERENCE' AND next_attempt_at <= now() FOR UPDATE SKIP LOCKED LIMIT 50`.
- Backoff: `min(2^attempts * 500ms, 60s)`; limite: **10 tentativas ou TTL 15 min** (justificativa: provedores costumam reenviar a referência em segundos; após 15 min é incidente).
- Otimização: ao processar uma BET/WIN, setar `next_attempt_at = now()` nos dependentes pendentes (mesma tx).
- Esgotou → REJECTED `REFERENCE_NOT_FOUND` + evento Rejected.

---

## 6. HTTP — mapeamento de status

| Situação | Status |
|---|---|
| Payload inválido / header ausente / OPENING submetido | **400** (`VALIDATION_ERROR`) |
| Não autenticado / provider do token ≠ body | 401 / 403 |
| Recurso inexistente (GET) | 404 |
| Idempotency key com payload diferente; wallet duplicada | **409** (`IDEMPOTENCY_CONFLICT`, `WALLET_ALREADY_EXISTS`) |
| Transação REJECTED (regra de negócio) | **422** com corpo completo + `failureCode` |
| PENDING_REFERENCE | **202** |
| PROCESSED novo | **201** ; replay → **200** com `idempotentReplay: true` (replay de REJECTED → 422 com replay:true) |
| Transitório (DB/lock timeout) | **503** + `Retry-After` |

Formato de erro único (`{ error: { code, message, details } }`) via exception filter global.

Ledger: cursor opaco = base64url de `sequence`; `ORDER BY sequence DESC`, `limit ≤ 200`.

Reconciliação: `SUM(CASE CREDIT +, DEBIT −)` em SQL (`numeric`) vs `balance_amount` + checar que o último `balance_after` == saldo; divergência → log `error`, `reconciliation_mismatch_total++`, `consistent:false`. Nunca corrige.

---

## 7. SQS

- `init.sh` do LocalStack: `wager-transactions.fifo` (VisibilityTimeout 30s, `ContentBasedDeduplication=false`), `wager-transactions-dlq.fifo`, redrive `maxReceiveCount=5`; `wallet-events.fifo`.
- Consumer (N por instância, `WaitTimeSeconds=20`, `MaxNumberOfMessages=10`):
  - parse/validação do envelope falhou → **permanente** → `SendMessage` para DLQ + `DeleteMessage` (métrica `dlq_messages_total`)
  - erro de negócio (REJECTED) → ack (delete)
  - transitório → não deleta; `ChangeMessageVisibility` com backoff por `ApproximateReceiveCount`; ao estourar `maxReceiveCount` o redrive manda à DLQ
  - sucesso → delete **após commit**
  - heartbeat estendendo visibilidade em processamentos longos
- `SIGTERM`: `app.enableShutdownHooks()`; para o polling, aguarda in-flight até 20s, devolve o resto com `ChangeMessageVisibility(0)`; para o publisher liberando leases.
- Nota no ARCHITECTURE: FIFO `MessageGroupId` bloqueia o grupo enquanto a mensagem está in-flight — explicar o efeito com PENDING_REFERENCE (não bloqueamos: persistimos e damos ack).

## 8. Outbox publisher

```
UPDATE outbox_messages SET locked_until = now()+'30s', locked_by=$instance
WHERE id IN (SELECT id FROM outbox_messages
             WHERE published_at IS NULL AND next_attempt_at <= now()
               AND (locked_until IS NULL OR locked_until < now())
             ORDER BY occurred_at LIMIT 50 FOR UPDATE SKIP LOCKED)
RETURNING *;
```
→ publica (`MessageDeduplicationId=eventId`, `MessageGroupId=aggregateId`) → `UPDATE published_at=now() WHERE id=$1 AND locked_by=$instance`. Falha → `scheduleRetry` (backoff exponencial, máx. ex. 20 tentativas → alerta/métrica, nunca descartar). Métrica `outbox_lag_seconds` = `now() - min(occurred_at) where published_at is null`.
Crash após publicar e antes de marcar → republica após lease: seguro porque consumidor dedup por `eventId` (e SQS FIFO dedup em 5 min ajuda).

---

## 9. Observabilidade

- Contexto ALS: `correlationId` (header `X-Correlation-Id` ou `messageId`), `messageId`, `transactionId`, `walletId`, `providerId` → mixin do pino.
- Redação: nunca logar `money`/payload completo nem tokens (`redact` do pino).
- Métricas: `wager_transactions_total{kind,status,source}`, `idempotent_replays_total`, `idempotency_conflicts_total`, `inbox_duplicates_total`, `processing_retries_total`, `lock_conflicts_total`, `dlq_messages_total`, `outbox_lag_seconds`, `outbox_publish_failures_total`, `pending_reference_gauge`, `processing_duration_seconds` (histogram), `reconciliation_mismatch_total`.
- `/health/live` (sempre 200) e `/health/ready` (`SELECT 1` + `GetQueueAttributes`), via `@nestjs/terminus` ou manual.

---

## 10. Testes (mapear 1:1 com a seção 13)

Helper central: `assertLedgerInvariant(walletId)` → `wallet.balance == Σ ledger` e cadeia `balance_before[n] == balance_after[n-1]`. Rodado no `afterEach` de **todo** teste de integração/concorrência.

**Unit** (rápidos, sem infra): Money (tabela de entradas inválidas, escala, moeda), Wallet (version, saldo ≥ 0), WagerTransaction (transições terminais lançam), ReversalPolicy (todas as combinações), payload hash canônico (ordem de chaves irrelevante, campo diferente → hash diferente).

**Integração** (Postgres + LocalStack reais):
- migrations up/down/up; cada constraint violada diretamente via SQL cru (UPDATE no ledger falha, saldo negativo falha, reversão dupla falha…)
- atomicidade: forçar exceção após ledger → nada persiste (inclusive inbox/outbox)
- redelivery da mesma mensagem → 1 efeito
- dois publishers sobre mesma outbox → cada evento publicado ≥1 e marcado 1x
- transitório → retry; permanente → DLQ; `maxReceiveCount` → DLQ
- restart: parar app, subir de novo, pendências drenam

**Concorrência** (paralelismo real):
1. 50× mesma BET com `Promise.all` em HTTP → 1 débito, 49 replays
2. 100.00 com 2× BET 80.00 → 1 PROCESSED / 1 REJECTED / saldo 20.00 / 1 DEBIT
3. N wallets em paralelo → sem interferência, throughput escala
4. **3 processos** via `Bun.spawn` (ou `docker compose --profile multi up --scale app=3`) consumindo a mesma fila com mensagens da mesma wallet
5. `FAULT=crash_after_commit_before_ack` → processo `process.exit(1)`; mensagem volta após visibilidade; outra instância → inbox detecta → ack sem efeito duplo
6. dois publishers (coberto acima, com crash entre publish e mark)
7. ROLLBACK antes da BET → PENDING_REFERENCE → BET chega → worker aplica
8. restart total com verificação de reconciliação em todas as wallets

Determinismo: `Clock` injetável, timeouts curtos configuráveis por env em teste, DB truncado por teste (ou schema por arquivo).

**Load (diferencial)**: `bun run test:load` com `autocannon`/`k6` ou script Bun: mix 70% wallets frias / 30% hot wallet; reportar RPS, p50/p95/p99, erros, `lock_conflicts`, outbox lag, máquina usada.

---

## 11. Cronograma sugerido (≈ 8–10 dias úteis)

| Fase | Entrega | Dias |
|---|---|---|
| 0. Spike | Bun+Nest+MikroORM+LocalStack rodando, compose, `bun test` vazio verde | 0,5 |
| 1. Domínio | Money, Wallet, LedgerEntry, WagerTransaction, ReversalPolicy, FailureCode, eventos + **testes unitários** | 1,5 |
| 2. Schema | migrations com todas as constraints/triggers + testes de constraint | 1 |
| 3. Wallet API | POST/GET wallets, OPENING, ledger paginado, reconciliação | 0,5 |
| 4. Use case + HTTP | ProcessWagerTransaction, idempotência, lock, status HTTP + testes de concorrência 1–3 | 1,5 |
| 5. Outbox | publisher multi-instância + testes | 1 |
| 6. SQS consumer | inbox, ack pós-commit, retry/DLQ, SIGTERM + testes 4–5 | 1,5 |
| 7. PENDING_REFERENCE | worker + teste 7 | 0,5 |
| 8. Observabilidade | logs ALS, métricas, health | 0,5 |
| 9. Docs + restart test | README, ARCHITECTURE (decisões, trade-offs, limitações), teste 8 | 0,5 |
| 10. Extras | Keycloak, load test, constraint trigger saldo↔ledger | resto |

Regra: cada fase termina com testes verdes e commit. Nunca deixar a fase 6 para o último dia — é onde mais aparece surpresa.

---

## 12. Checklist das falhas eliminatórias
- [ ] `grep -R "number" src/**/money*` e DTOs: nenhum valor monetário como number (lint rule custom ou teste)
- [ ] `CHECK (balance_amount >= 0)` + teste de race
- [ ] unique constraints de idempotência + teste 50×
- [ ] nenhuma idempotência em memória
- [ ] teste com ≥3 instâncias
- [ ] outbox só lido pelo publisher após commit (nenhum `send` dentro do use case)
- [ ] ledger append-only com trigger
- [ ] testes de integração usam Postgres e LocalStack reais

## 13. Limitações a declarar no ARCHITECTURE.md
- Moeda única na prática (BRL), modelo multi-moeda testado.
- Ledger single-entry (double-entry como evolução: conta "house" por moeda).
- Hot wallet serializa no lock: throughput por wallet limitado pela latência da tx (trade-off consciente).
- Reversão parcial fora de escopo.
- Auth (se não implementada): desenho Keycloak client-credentials descrito, ponto de extensão `ProviderIdentityPort`.
