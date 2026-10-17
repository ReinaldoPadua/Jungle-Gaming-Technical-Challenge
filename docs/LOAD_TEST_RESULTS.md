# Resultado do teste de carga

> Gerado por `bun run test:load` em 2026-10-17T22:51:00.965Z. Metodologia e análise: [LOAD_TEST.md](LOAD_TEST.md).

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
| 3 (pool 10 cada) | 32 | 1 s | 5.1 s | 40 + 1 quente | file |

Mix: bet 50%, win 15%, hot_bet 12%, loss 5%, refund 5%, overdraft 3%, replay 10%.

## Resultados (janela de medição)
| operação | requisições | req/s | p50 ms | p95 ms | p99 ms | máx ms | erro |
|---|---|---|---|---|---|---|---|
| **total** | 870 | 169.8 | 98.3 | 736.8 | 1697.5 | 3003.1 | 0.00% |
| bet | 418 | 81.6 | 94.3 | 298.0 | 369.3 | 511.3 | 0.00% |
| win | 133 | 26.0 | 103.7 | 327.1 | 417.8 | 499.1 | 0.00% |
| hot_bet | 117 | 22.8 | 614.3 | 1797.2 | 2451.9 | 3003.1 | 0.00% |
| loss | 43 | 8.4 | 73.7 | 230.1 | 396.7 | 396.7 | 0.00% |
| refund | 43 | 8.4 | 90.6 | 234.7 | 332.6 | 332.6 | 0.00% |
| overdraft | 25 | 4.9 | 55.8 | 266.2 | 279.8 | 279.8 | 0.00% |
| replay | 91 | 17.8 | 46.1 | 134.4 | 259.6 | 259.6 | 0.00% |

- **Status HTTP:** 200: 91 · 201: 754 · 422: 25
- **Taxa de erro** (resposta fora do esperado para a operação, 5xx ou falha de rede): **0.000%** (0/870; rede: 0)
- **Conflitos de concorrência:** lock timeouts/deadlocks = 0; transações re-tentadas = 0; replays idempotentes atendidos = 94
- **Outbox lag** (amostrado a cada 500 ms): p50 0.058 s · p95 0.526 s · máx 0.526 s · drenagem final 1 ms

## Invariantes ao final
| verificação | resultado |
|---|---|
| wallets com saldo ≠ ledger | 0 |
| wallets com saldo negativo | 0 |
| transações × idempotency keys distintas | 853 × 853 |
| transações não resolvidas (PENDING*) | 0 |
| eventos não publicados | 0 |
| lançamentos no ledger | 817 |
