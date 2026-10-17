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

## 4. Processamento de transações (fase 4)

`ProcessWagerTransactionUseCase` é o **único** caminho de entrada para HTTP e SQS (fase 6).
Uma transação SQL, nesta ordem:

```
1. INSERT … ON CONFLICT DO NOTHING (status PENDING)      ← idempotência decidida pelo banco
     └ conflito → SELECT por idempotency_key
          ├ mesmo payloadHash → replay (resultado original, idempotentReplay=true)
          ├ hash diferente   → 409 IDEMPOTENCY_KEY_PAYLOAD_MISMATCH
          └ achou só por (provider, externalId) → 409 EXTERNAL_TRANSACTION_ID_CONFLICT
2. SELECT wallet … FOR UPDATE                             ← lock por wallet
3. referência por (providerId, referenceExternalTransactionId) + reversões já aplicadas
4. settle()                                               ← regras puras do domínio
5. UPDATE tx · UPDATE wallet · INSERT ledger · INSERT outbox
6. wakeDependents (UPDATE … SKIP LOCKED)                  ← antecipa PENDING_REFERENCE
COMMIT → resposta HTTP / ack SQS
```

### Estratégia de concorrência — por que lock pessimista
- **Unidade de concorrência = wallet.** `SELECT … FOR UPDATE` na linha da wallet serializa
  apenas as operações daquela wallet; wallets diferentes rodam em paralelo (sem lock global).
- **Por que não optimistic locking?** Num hot wallet (o cenário de 50 requisições simultâneas),
  optimistic gera uma tempestade de conflitos/retries e latência imprevisível; o lock
  pessimista enfileira no banco e cada requisição é decidida uma única vez. O custo é o
  throughput por wallet ser limitado pela duração da transação — aceitável porque a transação é
  curta (só índices) e protegida por `lock_timeout` (2 s) e `statement_timeout` (5 s).
- **`version` continua existindo** como contrato do domínio e como verificação no banco
  (trigger exige +1 a cada mudança de saldo), mas não é o mecanismo de concorrência.
- **Sem deadlock por construção**: ordem fixa de locks — linha da transação (INSERT) →
  wallet. Duas requisições com a mesma chave: a segunda bloqueia no INSERT esperando a
  primeira (que não espera por ela) e, após o COMMIT dela, cai no ramo de replay.
  O `wakeDependents` usa `SKIP LOCKED` para nunca esperar por linhas que o worker de pendentes
  segura enquanto pede o lock da wallet. Se ainda assim ocorrer deadlock/lock timeout, o
  UnitOfWork re-tenta (até 3×).
- **O banco é a garantia final**: mesmo com um bug no use case, `CHECK (balance >= 0)`, a cadeia
  do ledger e os constraint triggers diferidos impedem saldo negativo, débito duplicado e
  divergência saldo ↔ ledger (fase 2). Ordenação/dedup do SQS FIFO serão só otimização.

### Replays
- A resposta de um replay é reconstruída da linha persistida: `status`, `failureCode` e
  `resultBalance` (o saldo observado na decisão — não o saldo atual).
- Uma transação `PENDING_REFERENCE` em replay continua 202; depois que o worker a aplicar, o
  replay passa a refletir o estado terminal (o resultado evolui; o efeito nunca se repete).
- Replays não geram eventos na outbox nem métricas de decisão (`idempotent_replays_total`).

### HTTP — `POST /wagering/transactions`
| Status | Significado | O provedor deve |
|---|---|---|
| 201 | `PROCESSED` agora | — |
| 200 | `PROCESSED` antes (replay) | — |
| 202 | `PENDING_REFERENCE` — aceita, aguardando a referência | consultar depois (GET) |
| 422 | `REJECTED` (novo ou replay); `failureCode` no corpo | ver `providerAction` do código |
| 400 | payload/header inválido (inclui `Idempotency-Key` ausente, `OPENING`, `amount` numérico) | corrigir |
| 409 | conflito de idempotência | não reenviar com esta chave |
| 503 | transitório (`Retry-After`) | reenviar a MESMA requisição |

`WALLET_NOT_FOUND`, `WALLET_PLAYER_MISMATCH` e `CURRENCY_MISMATCH` são 422 (regra de negócio
sobre estado), não 400: a transação é persistida como `REJECTED` e fica auditável.

### Testes de concorrência (`test/concurrency`) — paralelismo real
- mesma BET 50× em paralelo → 1×201 + 49×200, um único DEBIT;
- 100.00 com duas BET de 80.00 simultâneas, repetido 20× → sempre 201 + 422, saldo 20.00,
  um DEBIT; o 422 reporta o saldo 20.00 que viu após esperar o lock;
- hot wallet com 120 operações mistas: saldo final conferido em centavos inteiros (BigInt);
- 20 wallets × 10 apostas em paralelo;
- **3 processos independentes** (`Bun.spawn`, pools separados): mesma aposta enviada às 3
  instâncias; 30 apostas disputando 100.00 → exatamente 10 aplicadas; replays cruzados em
  5 wallets — cada transação decidida exatamente uma vez.
- `afterEach` de todas as suítes: `wallet.balance == Σ ledger` e nenhum `balance_after < 0`.

## 5. Transactional outbox (fase 5)

Os eventos (`WagerTransactionProcessed`, `WagerTransactionRejected`,
`WagerTransactionPendingReference`, `WalletBalanceChanged`) são gravados em `outbox_messages`
**na mesma transação SQL** da mudança financeira (fase 4). O `OutboxPublisher` só enxerga o que
já foi confirmado — é impossível publicar antes do commit (testado: uma linha de transação
aberta é invisível; uma transação revertida nunca vira evento).

### Ciclo do publisher
```
claim:   UPDATE … SET locked_until = now + lease, locked_by = <instância>
         WHERE id IN (SELECT … WHERE published_at IS NULL AND next_attempt_at <= now
                       AND (locked_until IS NULL OR locked_until < now)
                       ORDER BY occurred_at LIMIT n FOR UPDATE SKIP LOCKED)
publish: SendMessageBatch (FIFO: MessageGroupId = aggregateId, MessageDeduplicationId = eventId)
mark:    UPDATE … SET published_at = now WHERE id IN (…) AND published_at IS NULL
falha:   domínio calcula backoff (1 s → 5 min); grava attempts/next_attempt_at/last_error e solta o lease
```
- Cada comando é autocontido (autocommit): nenhuma transação fica aberta durante o I/O com o broker.
- **Múltiplos publishers**: `SKIP LOCKED` + lease garantem conjuntos disjuntos (testado com 5
  claims simultâneos e 3 publishers drenando 300 mensagens: cada uma publicada exatamente uma vez).
- **Crash**: se a instância morre com o lease (antes ou depois de publicar), o lease expira e
  outra assume. Garantia **at-least-once**, nunca perda.
- **Duplicatas seguras**: o id da mensagem é o `eventId`. O SQS FIFO descarta republicações dentro
  da janela de 5 min (otimização); consumidores devem deduplicar por `eventId` (garantia) e usar
  `walletVersion` para ordenar eventos da mesma wallet.
- **Nunca descarta**: tentativas ilimitadas com backoff; `outbox_publish_failures_total`,
  `outbox_pending_messages` e `outbox_lag_seconds` (idade da mensagem pendente mais antiga) tornam o
  problema visível em vez de silencioso.
- `markPublished` usa `published_at IS NULL`: se duas instâncias publicaram a mesma mensagem
  (lease expirado), a segunda marcação é no-op — o trigger `outbox_guard` proíbe reescrever a publicação.
- `SIGTERM`: `stop()` termina o ciclo em andamento; o lease de mensagens não marcadas expira.

### Ordem
Ordem total por wallet **não** é garantida entre publishers concorrentes (um lease expirado pode
republicar um evento antigo depois de um mais novo). Isso é intrínseco ao at-least-once; o contrato
para consumidores é: deduplicar por `eventId` e descartar `WalletBalanceChanged` com `walletVersion`
menor ou igual ao último aplicado.

### Testes
- `test/integration/outbox-publisher.test.ts` (Postgres real, broker em memória/arquivo): ordem,
  invisibilidade antes do commit, leases disjuntos, 3 publishers concorrentes, crash antes e depois
  de publicar, backoff/`last_error`, broker fora do ar, métricas de lag, start/stop — e um **crash
  real de processo** (`FAULTS=outbox:after-publish` → `process.exit(137)`; o sobrevivente republica).
- `test/integration/outbox-sqs.test.ts` (LocalStack): atributos FIFO, ordem por grupo, dedup por
  `eventId` e o mesmo crash real com SQS — o consumidor recebe cada evento exatamente uma vez.
  É pulada (com aviso) se o SQS não estiver acessível.

### Injeção de falhas
`FAULTS=<ponto>` arma pontos de crash (`outbox:after-publish`, `consumer:after-commit-before-ack`)
que chamam `process.exit(137)` — sem `finally`, sem flush, igual a um `kill -9`. Recusado em
`NODE_ENV=production`.

## 6. Consumidor SQS (fase 6)

`WagerConsumer` lê `wager-transactions.fifo` e chama **o mesmo** `ProcessWagerTransactionUseCase`
da entrada HTTP. A única diferença é o passo 0 dentro da mesma transação SQL:

```
INSERT inbox_messages (consumer_name, message_id) ON CONFLICT DO NOTHING
  ├ nova      → processa normalmente → marca processed_at → COMMIT → ack (DeleteMessage)
  ├ duplicata → mesmo hash: devolve o resultado já confirmado (sem efeito) → ack
  └ duplicata com conteúdo diferente → INBOX_PAYLOAD_MISMATCH → DLQ
```
Duas camadas de dedup: a **inbox** (mesma mensagem reentregue) e a **idempotency key** (mensagens
diferentes, ou HTTP e fila, para a mesma operação). O hash da inbox é SHA-256 do envelope em JSON
canônico.

### Classificação de desfechos
| Situação | Ação |
|---|---|
| `PROCESSED`, `REJECTED` (regra de negócio), `PENDING_REFERENCE`, replay, duplicata | **ack** após o COMMIT |
| JSON malformado, tipo desconhecido, envelope inválido (zod), `Money` inválido, contrato do domínio violado, conflito de idempotência, `INBOX_PAYLOAD_MISMATCH` | **permanente** → DLQ imediata (nenhum retry conserta) |
| `TransientError`, SQLSTATE transitório, erro de conexão | **transitório** → sem ack; `ChangeMessageVisibility` com backoff `base·2^(n-1)` |
| erro inesperado (bug, violação de integridade) | tratado como transitório **com limite** — nunca ack silencioso |
| entregas ≥ `CONSUMER_MAX_RECEIVES` (5) | DLQ (`MAX_RECEIVES_EXCEEDED`) |

A DLQ explícita leva `failureReason`, `failureDetail` e `originalReceiveCount` nos atributos. A
redrive policy da fila (`maxReceiveCount = 5`) continua como rede de segurança caso o próprio envio
à DLQ falhe.

### Ordem e paralelismo
Mensagens do mesmo `MessageGroupId` (walletId) num lote são tratadas **em sequência**; grupos
distintos em paralelo. Se uma mensagem do grupo falha, as seguintes do lote voltam para a fila sem
serem tocadas (`ChangeMessageVisibility 0`) — a ordem do grupo é preservada. O FIFO é otimização:
mesmo fora de ordem, o banco garante as invariantes (referência ausente vira `PENDING_REFERENCE`).
Custo conhecido: um backoff numa mensagem bloqueia o grupo (a wallet) durante o atraso.

### Visibilidade e shutdown
- `VisibilityTimeout` é passado no `ReceiveMessage` (30 s) e um heartbeat o estende a cada 1/3
  enquanto o processamento durar — evita que a mesma mensagem seja entregue a outro consumidor
  em paralelo durante uma transação lenta.
- `SIGTERM` (`beforeApplicationShutdown`, antes de o ORM fechar): aborta o long-poll, termina as
  mensagens já iniciadas (até `CONSUMER_SHUTDOWN_GRACE_MS`), devolve as recebidas e não iniciadas
  com visibilidade 0. O que eventualmente ficar no meio volta após o visibility timeout e a inbox
  deduplica. O publisher da outbox também para em `beforeApplicationShutdown`.

### Crash entre o commit e o ack
`FAULTS=consumer:after-commit-before-ack` mata o processo logo após o COMMIT. A mensagem reaparece
após o visibility timeout; o próximo consumidor encontra a inbox → ack sem efeito. Testado
in-process (fila em memória) e com **processo real + SQS** (`consumer-sqs.test.ts`).

### Testes
- `wager-consumer.test.ts` (Postgres real, FIFO em memória com visibility/redrive/ordem por grupo):
  caminho feliz, rejeição terminal, ordem BET→ROLLBACK, HTTP + fila com a mesma chave,
  redelivery, mensagens distintas com a mesma chave, `INBOX_PAYLOAD_MISMATCH`, crash pós-commit,
  envelopes e contratos inválidos → DLQ, conflito de idempotência → DLQ, transitório com retry,
  transitório persistente → DLQ, ordem preservada após falha, shutdown, 3 consumidores com
  duplicatas, consumidor + HTTP concorrentes.
- `consumer-sqs.test.ts` (LocalStack): processamento real, DLQ com atributos, crash real entre
  commit e ack, `MAX_RECEIVES_EXCEEDED`.

## 7. Referências fora de ordem — worker de PENDING_REFERENCE (fase 7)

Quando a referência de um REFUND/ROLLBACK (ou a referência opcional de um WIN/LOSS) ainda não
existe — ou existe mas não é terminal — a transação é persistida como `PENDING_REFERENCE`, a
resposta é **202** (HTTP) ou **ack** (fila) e o evento `WagerTransactionPendingReference` é emitido
uma única vez.

### Worker
`PendingReferenceWorker` roda em todas as instâncias (`PENDING_WORKER_ENABLED`):
```
SELECT id … WHERE status = 'PENDING_REFERENCE' AND next_attempt_at <= now ORDER BY next_attempt_at LIMIT n
para cada id, numa transação SQL própria:
  SELECT … FOR UPDATE SKIP LOCKED   (a pendente — exclusividade entre workers/instâncias)
  → SettlementService.settleAndPersist  (lock da wallet → referência → settle() → persistência)
```
- O `SettlementService` é o **mesmo** código usado pelo HTTP e pela fila: as regras de negócio e a
  persistência não são duplicadas. Ordem de locks idêntica (linha da transação → wallet).
- `wakeDependents` (fase 4) antecipa `next_attempt_at` quando a referência chega, então o worker
  aplica no próximo ciclo em vez de esperar o backoff. Cadeias (ROLLBACK de um REFUND pendente)
  se resolvem em sequência: cada transação terminal acorda as que dependem dela.
- Reagendamentos não emitem evento (só a primeira chegada); a decisão final emite
  `WagerTransactionProcessed` (+ `WalletBalanceChanged`) ou `WagerTransactionRejected`.

### Limite — 10 tentativas ou 15 minutos
Backoff exponencial 500 ms → 1 s → 2 s … até 60 s. Esgotado qualquer dos dois limites →
`REJECTED / REFERENCE_NOT_FOUND`. Justificativa: provedores entregam a referência em segundos;
depois de 15 min é um incidente operacional e o provedor precisa ser avisado em vez de esperar
indefinidamente. Se a referência chega antes do worker decidir, ela é usada mesmo após o TTL (a
espera só existe porque faltava a referência).

Métricas: `pending_reference_retries_total{result}`, `pending_reference_transactions` (gauge),
`pending_reference_wakeups_total`.

### Testes (`pending-reference.test.ts`)
ROLLBACK antes da BET via HTTP (202 → aplicado, replay reflete o estado final, evento pendente
emitido uma vez); REFUND antes da BET via fila; cadeia ROLLBACK(REFUND(BET)) chegando ao contrário;
referência que nunca chega → `REFERENCE_NOT_FOUND`; TTL; backoff crescente; referência inválida
→ código específico; ROLLBACK de WIN gasto → `REVERSAL_WOULD_OVERDRAW`; 3 workers concorrentes
sobre 30 pendentes (cada uma aplicada uma vez); worker + HTTP concorrentes na mesma wallet.

## 8. Observabilidade (fase 8)

### Logs estruturados
Uma linha JSON por evento (`JsonLogger`, sem dependência externa):
```json
{"level":"info","time":"…","msg":"wager transaction handled","service":"wagering","instanceId":"…",
 "correlationId":"corr-abc","transactionId":"…","walletId":"…","providerId":"provider-a",
 "kind":"BET","source":"http","outcome":"processed","status":"PROCESSED","durationMs":12}
```
- **Correlação automática** via `AsyncLocalStorage` (`logContext`): o middleware HTTP abre o
  contexto com o `X-Correlation-Id` recebido (ou gera um UUID v7) e o devolve no header da
  resposta; o consumidor abre um contexto por mensagem (`correlationId = messageId`); o worker de
  pendentes, um por transação. Use cases e controllers só **enriquecem** (`transactionId`,
  `walletId`, `providerId`) — ninguém passa ids de log por parâmetro. Fluxos concorrentes não se
  misturam (testado).
- **Sem dados sensíveis**: redação recursiva por nome de chave (`money`, `amount`, `balance*`,
  `payload`, `body`, `data`, `authorization`, `token`, …) → `[REDACTED]`. O corpo das requisições
  e mensagens nunca é logado; logs de reconciliação dizem *que* divergiu, não *quanto* (o valor está
  na resposta). Um teste varre todos os logs de um fluxo completo procurando os valores usados.
- Logs do próprio Nest também saem em JSON (`warn`/`error`). Nível por `LOG_LEVEL`.
- Uma linha de acesso por requisição (`http request`: método, rota-padrão, status, duração);
  `/health/*` e `/metrics` não poluem o log.

### Métricas (`GET /metrics`, Prometheus)
| Exigência (seção 12) | Métrica |
|---|---|
| transações por status | `wager_transactions_total{kind,status,source}` |
| duplicatas detectadas | `idempotent_replays_total{source}`, `inbox_duplicates_total{consumer}`, `idempotency_conflicts_total{reason}` |
| retries | `db_transaction_retries_total`, `consumer_retries_total`, `pending_reference_retries_total{result}`, `outbox_publish_failures_total` |
| mensagens em DLQ | `dlq_messages_total{reason}` |
| conflitos de lock | `db_lock_conflicts_total{sqlstate}` (55P03 lock_timeout, 40P01 deadlock) |
| outbox lag | `outbox_lag_seconds`, `outbox_pending_messages` |
| latência de processamento | `wager_processing_duration_seconds{kind,outcome,source}` (histograma) |
| extras | `http_requests_total` / `http_request_duration_seconds{method,route,status}`, `consumer_messages_total{outcome}`, `pending_reference_transactions`, `reconciliation_mismatches_total`, métricas padrão do processo |

Rótulos de rota usam o padrão do Express (`/wallets/:walletId`) — nunca ids, para não explodir a
cardinalidade. Todas as séries carregam `instance_id`.

### Health checks
`GET /health/live` (processo responde, não toca dependências) e `GET /health/ready` (PostgreSQL
`SELECT 1` + SQS `GetQueueAttributes`, timeout de 2 s cada; 503 se algum falhar). Sem autenticação.

### Diagnóstico de um conflito de lock (testado)
Outra transação segura o lock da wallet → `lock_timeout` (55P03) → 2 re-tentativas com backoff →
503 + `Retry-After: 1`. Ficam registrados: `db_lock_conflicts_total{sqlstate="55P03"} += 3`,
`db_transaction_retries_total += 2`, dois `warn` "transient database error, retrying transaction" e
um `error` final com `walletId`/`correlationId`. Nada é gravado; reenviar a mesma requisição funciona.
