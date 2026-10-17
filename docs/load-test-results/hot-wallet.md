# Resultado do teste de carga

> Gerado por `bun run test:load` em 2026-10-17T22:52:52.433Z. Metodologia e análise: [LOAD_TEST.md](../LOAD_TEST.md).

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
| 3 (pool 10 cada) | 32 | 5 s | 30.6 s | 200 + 1 quente | file |

Mix (pesos): bet 50, win 15, hot_bet 12, loss 5, refund 5, overdraft 3, replay 10.

## Resultados (janela de medição)
| operação | requisições | req/s | p50 ms | p95 ms | p99 ms | máx ms | erro |
|---|---|---|---|---|---|---|---|
| **total** | 7065 | 230.7 | 56.7 | 648.7 | 1589.0 | 3935.8 | 0.00% |
| bet | 3483 | 113.7 | 52.3 | 172.6 | 350.1 | 759.7 | 0.00% |
| win | 1030 | 33.6 | 53.6 | 163.3 | 341.5 | 648.3 | 0.00% |
| hot_bet | 863 | 28.2 | 503.6 | 1849.4 | 2928.6 | 3935.8 | 0.00% |
| loss | 358 | 11.7 | 43.4 | 159.1 | 279.0 | 351.5 | 0.00% |
| refund | 387 | 12.6 | 58.3 | 187.2 | 342.1 | 758.4 | 0.00% |
| overdraft | 192 | 6.3 | 44.9 | 143.3 | 393.7 | 400.9 | 0.00% |
| replay | 752 | 24.6 | 29.2 | 131.8 | 233.1 | 491.4 | 0.00% |

- **Status HTTP:** 200: 719 · 201: 6121 · 422: 225
- **Taxa de erro** (resposta fora do esperado para a operação, 5xx ou falha de rede): **0.000%** (0/7065; rede: 0)
- **Conflitos de concorrência:** lock timeouts/deadlocks = 0; transações re-tentadas = 0; replays idempotentes atendidos = 843
- **Outbox lag** (amostrado a cada 500 ms): p50 0.140 s · p95 1.889 s · máx 3.873 s · drenagem final 4 ms

## Invariantes ao final
| verificação | resultado |
|---|---|
| wallets com saldo ≠ ledger | 0 |
| wallets com saldo negativo | 0 |
| transações × idempotency keys distintas | 7129 × 7129 |
| transações não resolvidas (PENDING*) | 0 |
| eventos não publicados | 0 |
| lançamentos no ledger | 6706 |
