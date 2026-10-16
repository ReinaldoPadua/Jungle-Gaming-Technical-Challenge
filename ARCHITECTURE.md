# Arquitetura — Distributed Wagering Processor

> Documento vivo: cada fase acrescenta suas decisões. Plano completo em [`docs/PLAN.md`](docs/PLAN.md).

## 1. Domínio (fase 1)

O domínio (`src/shared/domain`, `src/modules/*/domain`) não importa NestJS, MikroORM nem AWS —
um teste de arquitetura (`test/unit/architecture-guards.test.ts`) garante isso, assim como a
ausência de campos monetários tipados como `number`.

### Money
- `big.js` em **modo estrito** (rejeita `number` na construção; `valueOf` lança), escala fixa 2.
- Entrada aceita: `^(0|[1-9]\d{0,17})(\.\d{1,2})?$` — não-negativo, sem sinal, sem notação
  científica, sem zeros à esquerda, até 18 dígitos inteiros (limite de `numeric(20,2)`).
- **Nunca arredonda**: mais de 2 casas é rejeitado. Como não há divisão/multiplicação no domínio,
  nenhuma operação introduz casas extras. `"25"` e `"25.5"` são normalizados para `"25.00"`/`"25.50"`.
- Operações entre moedas diferentes lançam `CurrencyMismatchError`; `equals` retorna `false`.

### Wallet (aggregate root)
- `debit`/`credit`/`move` são a **única** forma de alterar o saldo e sempre devolvem o
  `WalletLedgerEntry` correspondente — saldo e ledger não podem divergir no domínio.
- O lançamento é criado (e validado) **antes** de mutar o agregado: se algo falhar, o estado fica intacto.
- `version` nasce em 1 (já incluindo o saldo de abertura) e incrementa só quando o saldo muda.
  O lançamento recebe `sequence = version` resultante → ordem total por wallet e cursor estável no ledger.
- `Wallet.open` devolve `{ wallet, openingEntry }`: saldo inicial > 0 gera a transação interna
  `OPENING` e um `CREDIT` com `sequence 1`.

### WalletLedgerEntry
- Congelado na construção (`Object.freeze`); sem setters nem transições.
- `create` valida: valor > 0, moedas iguais, saldos não-negativos, `before ± money === after`.

### WagerTransaction — estados

```
PENDING ─────────────► PROCESSED | REJECTED | FAILED   (terminais)
   │                        ▲
   ▼                        │
PENDING_REFERENCE ──────────┘   (reagenda: attempts++, nextAttemptAt com backoff)
```

Transição a partir de estado terminal lança `InvalidTransactionStateError` (erro de programação).
`resultBalance` guarda o saldo observado na decisão — é o que um replay devolve (regra 7.7).

### Regras de negócio — `settle()` (serviço de domínio puro)
Ordem de avaliação: wallet existe → pertence ao player → moeda → referência → efeito no saldo.

| Operação | Referência | Efeito |
|---|---|---|
| BET | proibida | DEBIT; sem saldo → `INSUFFICIENT_FUNDS` |
| WIN | opcional (→ BET) | CREDIT |
| LOSS | opcional (→ BET) | nenhum (aceita valor `0.00`) |
| REFUND | obrigatória (→ BET) | CREDIT |
| ROLLBACK | obrigatória (→ BET, WIN, REFUND) | inverso da referência; estouro → `REVERSAL_WOULD_OVERDRAW` |

Interpretações adotadas:
1. **Uma transação é revertida no máximo uma vez, por qualquer tipo.** A regra 4 proíbe repetir o
   mesmo tipo; fomos além e bloqueamos REFUND + ROLLBACK da mesma BET, que geraria crédito em dobro.
   No banco: índice único parcial em `reference_transaction_id` para reversões `PROCESSED`.
   Consequência conhecida: uma BET cujo REFUND foi desfeito por ROLLBACK não pode ser reembolsada de novo.
2. Referência ainda não terminal (`PENDING`/`PENDING_REFERENCE`) → o dependente **espera**, como se
   ela não existisse. Referência `REJECTED`/`FAILED` → `REFERENCE_NOT_PROCESSED`.
3. Referência é resolvida por `(providerId, referenceExternalTransactionId)`: a de outro provider
   simplesmente não é encontrada; a de outro player/wallet/moeda/rodada → `REFERENCE_MISMATCH`.
4. Espera por referência: backoff 500 ms → 60 s, até **10 tentativas ou 15 min** (o que vier
   primeiro); esgotado → `REFERENCE_NOT_FOUND`.
5. `providerId = "internal"` é reservado para transações `OPENING`.

### Códigos de falha
Ver `src/modules/wagering/domain/failure-code.ts`: cada código traz `providerAction`
(`GIVE_UP`, `FIX_PAYLOAD`, `ESCALATE`). Todos são terminais — reenviar a mesma requisição devolve o
mesmo resultado.

### Idempotência — payloadHash
`hex(SHA-256(canonicalJson(subconjunto)))`, onde o subconjunto é
`providerId, externalTransactionId, playerId, walletId, roundId, gameId, kind, money, referenceExternalTransactionId`.
JSON canônico: chaves ordenadas recursivamente, `undefined` omitido, sem espaços, números proibidos.
`money.amount` entra normalizado (escala 2). Header e metadados de transporte ficam fora.

### Eventos
`IntegrationEvent<T>` abstrato; `eventType` e `version` declarados em cada subclasse
(`WagerTransactionProcessed`, `WagerTransactionRejected`, `WagerTransactionPendingReference`,
`WalletBalanceChanged`). `data` é cópia JSON congelada — só `MoneyProps`, nunca `Money`.
O id da `OutboxMessage` é o `eventId`, chave de deduplicação dos consumidores.

## 2. Schema e persistência (fase 2)

Migrations em SQL escrito à mão (`migrations/`), reversíveis e testadas (`up → down → up`).
O schema é a **última linha de defesa**: todas as garantias abaixo valem mesmo para SQL cru,
sem passar pela aplicação (`test/integration/schema-constraints.test.ts`, 46 casos).

### Garantias por tabela

| Garantia | Mecanismo |
|---|---|
| saldo ≥ 0 | `CHECK (balance_amount >= 0)` em `wallets` e `CHECK` nos saldos do ledger |
| uma wallet por player + moeda | `UNIQUE (player_id, currency)` |
| `version` só muda com o saldo, sempre +1 | trigger `wallets_guard` |
| todo saldo tem o lançamento que o produziu | constraint trigger **diferido** `wallets_commit_check` (no COMMIT: existe lançamento com `sequence = version` e `balance_after = balance`) |
| idempotência | `UNIQUE (idempotency_key)` e `UNIQUE (provider_id, external_transaction_id)` |
| estados terminais imutáveis; campos da requisição imutáveis; sem DELETE | trigger `wager_transactions_guard` |
| referência no mesmo wallet/provider/player/rodada/moeda | FK composta `wtx_reference_scope_fk` |
| reversão única | índice único parcial `wtx_single_reversal_uq` sobre `reference_transaction_id` (reversões `PROCESSED`) |
| uma OPENING por wallet | índice único parcial `wtx_single_opening_uq` |
| ledger append-only | trigger `forbid_mutation()` em UPDATE/DELETE |
| aritmética do lançamento | `CHECK (after = before ± amount)` |
| ≤ 1 lançamento por transação/wallet; ordem total | `UNIQUE (transaction_id, wallet_id)`, `UNIQUE (wallet_id, sequence)` |
| valor, moeda e wallet do lançamento = os da transação | FK composta `(transaction_id, wallet_id, currency, amount)` |
| moeda do lançamento = moeda da wallet | FK composta `(wallet_id, currency)` |
| cadeia contínua (`before[n] = after[n-1]`, `sequence` +1) | trigger `wle_chain_guard` |
| lançamento só para transação `PROCESSED` que move saldo, na direção certa | constraint trigger diferido `wle_commit_check` (LOSS não tem lançamento; ROLLBACK inverte a direção do lançamento da referência) |
| dedup de mensagens | PK `(consumer_name, message_id)` em `inbox_messages` |
| envelope da outbox imutável; publicação definitiva | `CHECK` (payload contém o próprio `eventId`) + trigger `outbox_guard` |

Erros dos triggers usam SQLSTATE da classe 23 (`check_violation`, `restrict_violation`): a
aplicação os trata como violação de integridade (bug ou dado inválido), nunca como erro transitório.

Decisões:
- **`wager_transactions.wallet_id` sem FK para `wallets`**: uma transação para wallet inexistente
  precisa ser persistida como `REJECTED / WALLET_NOT_FOUND` e continuar auditável.
- **Constraint triggers diferidos** permitem a ordem natural de escrita dentro da transação SQL
  (wallet antes do ledger, ou vice-versa) e verificam o estado *final* no COMMIT.
- **`TRUNCATE` não dispara triggers de linha**: usado só pela suíte de testes. Em produção, o role
  da aplicação não deve ter privilégio de TRUNCATE/DELETE sobre o ledger (documentado como hardening).

### Mapeamento ORM
- O domínio não tem decorators. Cada tabela tem um **registro de persistência** (`*Record`) mapeado
  por `EntitySchema` e um **mapper** que converte via `rehydrate` (leitura) e `toState` (escrita).
- `numeric` é mapeado como `decimal` → **string** no TypeScript; `Money` é reconstruído por
  `Money.from({ amount, currency })` com valor e moeda em colunas separadas.
- `version` **não** usa o optimistic lock do MikroORM: a regra de incremento é do domínio e a
  concorrência é pessimista (fase 4).
- As migrations são a fonte de verdade do schema. Um teste garante que toda coluna mapeada existe
  no banco; CHECKs, índices parciais e triggers não são modelados no metadata do ORM.
- Sem relações declaradas entre os `EntitySchema`, a ordem de INSERT é controlada com `flush()`
  explícito (transação → wallet → ledger). O use case da fase 4 encapsula isso.

## 3. API de wallet (fase 3)

### Camadas
```
interface/http (controllers, zod, filtro de erros)
   └─► application (use cases puros + portas: UnitOfWork, repositórios, Clock, IdGenerator, Metrics, Logger)
          └─► domain
infrastructure (MikroORM: UnitOfWork + repositórios, Prometheus, SQS) implementa as portas
```
Use cases não têm decorators do Nest: os módulos só fazem composição via `useFactory`.

### UnitOfWork
- `uow.run(work)` = um `EntityManager` novo (fork limpo) + **uma** transação SQL; os
  repositórios entregues a `work` estão presos a ela. Cada escrita faz `flush` imediato, então a
  ordem dos comandos SQL é a ordem das chamadas (FKs compostas/triggers), e o COMMIT é único.
- `SET LOCAL lock_timeout` (2 s) e `statement_timeout` (5 s) por transação: nenhuma requisição
  fica presa indefinidamente atrás de um lock.
- Erros transitórios (`40001`, `40P01`, `55P03`, `57014`, `08xxx`, …) são re-tentados até 3×
  com backoff exponencial + jitter; esgotado → `TransientError` (HTTP 503 + `Retry-After`).
  Violações de integridade (`23xxx`) **nunca** são re-tentadas. Contadores:
  `db_transaction_retries_total`, `db_lock_conflicts_total`.

### Endpoints
| Endpoint | Notas |
|---|---|
| `POST /wallets` | OPENING + CREDIT + `WalletBalanceChanged` (outbox) na mesma transação; duplicata (player, moeda) → 409 pela constraint única (seguro entre instâncias — testado com 20 requisições simultâneas) |
| `GET /wallets/:id` | |
| `GET /wallets/:id/ledger?cursor&limit` | do mais recente ao mais antigo; `limit` 1–200 (default 50) |
| `POST /wallets/:id/reconciliation` | ver abaixo |
| `GET /metrics` | Prometheus |

**Cursor do ledger**: base64url de `{v, w, s}` (versão, wallet, último `sequence` entregue).
Como `sequence` é único e imutável por wallet, lançamentos novos não deslocam páginas já lidas
(diferente de OFFSET). Cursor malformado ou de outra wallet → 400 `INVALID_CURSOR`.

**Reconciliação**: lê wallet e ledger no mesmo snapshot (`REPEATABLE READ`, read-only — não
bloqueia escritores). A soma é feita em `numeric` no banco. Além de `stored == Σ ledger`, verifica
a continuidade da cadeia (window function `lag`) e se o último `balance_after` bate com o saldo.
Divergência → log `error`, `reconciliation_mismatches_total++`, `consistent: false`; **nada é
corrigido**. Como o schema impede divergência, o teste a simula desligando os triggers.

### Erros HTTP (envelope único `{ "error": { code, message, details? } }`)
| Status | Quando |
|---|---|
| 400 | contrato inválido (zod), `Money` inválido, regra de formato do domínio, cursor inválido |
| 404 | recurso ou rota inexistente |
| 409 | conflito: wallet duplicada; (fase 4) idempotency key com payload diferente |
| 422 | (fase 4) rejeição por regra de negócio — corpo traz o resultado da transação |
| 202 | (fase 4) aceito com processamento pendente (`PENDING_REFERENCE`) |
| 503 | falha transitória de infraestrutura, com `Retry-After` |
| 500 | bug — sem detalhes internos na resposta, logado com stack |

`amount` numérico no JSON é rejeitado já no schema zod (`must be a decimal string, not a number`).
