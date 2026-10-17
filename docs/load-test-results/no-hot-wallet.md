# Resultado do teste de carga

> Gerado por `bun run test:load` em 2026-10-17T22:53:41.579Z. Metodologia e análise: [LOAD_TEST.md](../LOAD_TEST.md).

## Ambiente
| | |
|---|---|
| SO / arquitetura | Linux 6.8.0-138-generic / arm64 |
| CPUs / memória | 4 vCPU · 3.8 GiB |
| Runtime | Bun 1.2.23 |
| Banco | PostgreSQL 18.4 on aarch64-unknown-linux-gnu (max_connections 100) |
| Gerador de carga | mesmo host, `fetch` com keep-alive, loop fechado |

## Parâmetros
| instâncias | clientes concorrentes | aquecimento | medição | wallets frias | outbox |
|---|---|---|---|---|---|
| 3 (pool 10 cada) | 32 | 5 s | 30.1 s | 200 + 1 quente | file |

Mix (pesos): bet 50, win 15, loss 5, refund 5, overdraft 3, replay 10.

## Resultados (janela de medição)
| operação | requisições | req/s | p50 ms | p95 ms | p99 ms | máx ms | erro |
|---|---|---|---|---|---|---|---|
| **total** | 10229 | 340.2 | 85.8 | 204.1 | 287.3 | 511.5 | 0.00% |
| bet | 5751 | 191.2 | 91.8 | 209.3 | 286.7 | 498.8 | 0.00% |
| win | 1807 | 60.1 | 91.8 | 212.3 | 301.8 | 511.5 | 0.00% |
| hot_bet | 0 | 0.0 | 0.0 | 0.0 | 0.0 | 0.0 | 0.00% |
| loss | 572 | 19.0 | 76.7 | 162.2 | 272.3 | 389.9 | 0.00% |
| refund | 584 | 19.4 | 106.8 | 237.3 | 385.0 | 489.2 | 0.00% |
| overdraft | 340 | 11.3 | 77.4 | 183.2 | 318.2 | 452.4 | 0.00% |
| replay | 1175 | 39.1 | 50.1 | 133.3 | 186.5 | 325.5 | 0.00% |

- **Status HTTP:** 200: 1122 · 201: 8714 · 422: 393
- **Taxa de erro** (resposta fora do esperado para a operação, 5xx ou falha de rede): **0.000%** (0/10229; rede: 0)
- **Conflitos de concorrência:** lock timeouts/deadlocks = 0; transações re-tentadas = 0; replays idempotentes atendidos = 1322
- **Outbox lag** (amostrado a cada 500 ms): p50 0.091 s · p95 0.229 s · máx 0.753 s · drenagem final 4 ms

## Invariantes ao final
| verificação | resultado |
|---|---|
| wallets com saldo ≠ ledger | 0 |
| wallets com saldo negativo | 0 |
| transações × idempotency keys distintas | 10265 × 10265 |
| transações não resolvidas (PENDING*) | 0 |
| eventos não publicados | 0 |
| lançamentos no ledger | 9462 |
