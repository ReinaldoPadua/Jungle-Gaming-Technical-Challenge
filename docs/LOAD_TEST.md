# Teste de carga — metodologia e análise

`bun run test:load` executa `scripts/load-test.ts`. Não há meta de RPS: o objetivo é medir com
honestidade onde a solução gasta tempo, como se comporta sob contenção e se as invariantes
continuam valendo sob carga. Relatórios brutos de cada execução em [`load-test-results/`](load-test-results).

## Como reproduzir

```bash
bun run infra:up                         # Postgres (+ LocalStack se LOAD_OUTBOX=sqs)
bun run test:load                        # padrão: 3 instâncias, 32 clientes, 5 s + 30 s
LOAD_HOT_WEIGHT=0 bun run test:load      # sem a wallet quente
LOAD_INSTANCES=1 bun run test:load       # uma instância
LOAD_OUTBOX=sqs bun run test:load        # publisher da outbox publicando no SQS real
```
Usa o banco de **teste** (recusa qualquer `DATABASE_URL` que não termine em `_test`) e o recria do zero.

## Metodologia

- **Sistema sob teste:** N processos independentes da aplicação (HTTP + use case + worker de
  pendentes, pool de 10 conexões cada) contra o mesmo PostgreSQL. Um `OutboxPublisher` real roda
  em paralelo (destino: arquivo por padrão, ou SQS), para que o *outbox lag* seja medido com um
  publisher de fato consumindo, e não apenas a fila crescendo.
- **Gerador:** 32 clientes em **loop fechado** (cada um envia a próxima requisição ao receber a
  resposta), em round-robin entre as instâncias, com `fetch` e keep-alive. 5 s de aquecimento,
  descartados, seguidos de 30 s de medição.
- **Dados:** 200 wallets "frias" (1000.00 cada) e 1 wallet "quente" com saldo alto.
- **Mix (pesos):**

  | operação | peso | o que exercita |
  |---|---|---|
  | `bet` | 50 | aposta em wallet fria aleatória (baixa contenção) |
  | `win` | 15 | crédito em wallet fria |
  | `hot_bet` | 12 | aposta na **mesma** wallet: contenção máxima no lock da wallet |
  | `loss` | 5 | registra o resultado sem mover saldo |
  | `refund` | 5 | reversão de uma BET já aplicada (resolução de referência + reversão única) |
  | `overdraft` | 3 | aposta sem saldo → 422 |
  | `replay` | 10 | reenvio idêntico de uma requisição anterior → caminho de idempotência |

- **Métricas:** latência medida no cliente (fim a fim, HTTP incluso), separada por operação. Taxa de
  erro = resposta fora do esperado para a operação, 5xx ou falha de rede. Conflitos de
  concorrência lidos de `/metrics` de cada instância (`db_lock_conflicts_total`,
  `db_transaction_retries_total`). Outbox lag amostrado a cada 500 ms no banco (idade da mensagem
  pendente mais antiga).
- **Verificação final:** saldo == ledger em todas as wallets, nenhum saldo negativo, uma transação
  por idempotency key, nada `PENDING*`, nada sem publicar. O script sai com código 1 se alguma
  invariante falhar.

## Ambiente das execuções registradas

| | |
|---|---|
| Host | VM Linux arm64, **4 vCPU**, 3.8 GiB, compartilhada entre **gerador, instâncias e banco** |
| Runtime | Bun 1.2.23 |
| Banco | PostgreSQL 18.4 (binário embarcado, configuração padrão, `max_connections` 100) |
| Outbox | publisher único, destino arquivo (sem latência de rede do SQS) |

Esse ambiente é pequeno e **co-localizado**: todos os números abaixo são limitados pela CPU
compartilhada. Eles servem para comparar cenários entre si, não como capacidade absoluta.

## Resultados (janela de 30 s)

| cenário | req/s | p50 ms | p95 ms | p99 ms | erro | lock timeouts / retries | outbox lag p95 / máx |
|---|---|---|---|---|---|---|---|
| 3 instâncias, com wallet quente | **230.7** | 56.7 | 648.7 | 1589.0 | 0.00 % | 0 / 0 | 1.89 s / 3.87 s |
| └ só `hot_bet` | 28.2 | 503.6 | 1849.4 | 2928.6 | 0.00 % | | |
| └ só `bet` (wallets frias) | 113.7 | 52.3 | 172.6 | 350.1 | 0.00 % | | |
| 3 instâncias, sem wallet quente | **340.2** | 85.8 | 204.1 | 287.3 | 0.00 % | 0 / 0 | 0.23 s / 0.75 s |
| 1 instância, sem wallet quente | **443.0** | 67.7 | 109.8 | 153.4 | 0.00 % | 0 / 0 | 0.06 s / 0.47 s |

Em **todas** as execuções: 0 wallets inconsistentes, 0 saldos negativos, transações == idempotency
keys distintas (ex.: 7129 × 7129), 0 pendentes, 0 eventos sem publicar ao final.

## Análise

**1. A wallet quente é serializada, como projetado, e isso tem um custo visível.** As operações na
wallet quente saem a ~28/s com p50 de 500 ms: cada uma espera o `FOR UPDATE` das anteriores. Isso
é a consequência direta da escolha de lock pessimista por wallet (`ARCHITECTURE.md` §4), que dá
corretude sem tempestade de retries: **0 lock timeouts e 0 retries** mesmo com 12 % do tráfego
disputando a mesma linha. O efeito colateral mais importante não é a latência da própria wallet
quente, e sim o **head-of-line blocking no pool**: transações esperando o lock ocupam conexões
do pool (10 por instância) e atrasam as operações em wallets frias. O p95 total sobe de 204 ms para
649 ms, e o throughput total cai de 340 para 231 req/s.
Mitigações possíveis, não implementadas: (a) um pool separado ou um limite de concorrência por
wallet na aplicação, para que transações esperando lock não monopolizem conexões; (b) enfileirar
por wallet antes do banco (o SQS FIFO por `MessageGroupId` já faz isso naturalmente na entrada
por fila); (c) encurtar a transação, removendo leituras que poderiam ir para antes do lock.

**2. Escalar para 3 instâncias no mesmo host de 4 vCPU piorou: de 443 para 340 req/s.** O gargalo é
CPU compartilhada entre gerador, aplicação e Postgres: com 3 processos há mais troca de contexto e
3× mais conexões ativas no Postgres (30 contra 10), aumentando a contenção interna do banco. O
teste de 3 instâncias aqui prova **corretude** em multi-instância (o objetivo do desafio), não
ganho de throughput. Medir escala horizontal exige instâncias em hosts separados do banco e do
gerador.

**3. Idempotência é barata.** Replays respondem em p50 de 29–50 ms (contra 52–92 ms de uma aposta
nova): o caminho é um `INSERT … ON CONFLICT DO NOTHING` seguido de um `SELECT` por índice único,
sem lock de wallet.

**4. O outbox lag acompanha a saturação.** Sem contenção, o p95 é 0.06–0.23 s. Com a wallet quente
e CPU saturada, um único publisher chega a picos de 3.9 s. Ainda assim tudo é drenado ao final
(drenagem final de 4–112 ms) e nada se perde. Em produção, cada instância roda o seu publisher (os
leases dividem o trabalho) e o lag deve ser monitorado por `outbox_lag_seconds`.

**5. Zero erros e invariantes intactas sob carga**, incluindo 422 corretos para apostas sem saldo e
reversões únicas. Nenhum 5xx, nenhuma falha de rede.

## Limitações do experimento

- Gerador, aplicação e banco no mesmo host: a latência inclui a disputa por CPU entre eles.
- PostgreSQL com configuração padrão (sem ajuste de `shared_buffers`, `work_mem`, `synchronous_commit`).
- O destino da outbox é arquivo; com `LOAD_OUTBOX=sqs` entram a latência e os limites do SQS (LocalStack).
- Loop fechado mede capacidade sob concorrência fixa; não modela chegada aberta (Poisson) nem picos.
- 30 s de medição: não detecta degradação de longa duração (bloat, autovacuum, crescimento da inbox).
