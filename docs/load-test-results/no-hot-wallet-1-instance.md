# Resultado do teste de carga

> Gerado por `bun run test:load` em 2026-10-17T22:54:30.434Z. Metodologia e análise: [LOAD_TEST.md](../LOAD_TEST.md).

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
| 1 (pool 10 cada) | 32 | 5 s | 30.1 s | 200 + 1 quente | file |

Mix (pesos): bet 50, win 15, loss 5, refund 5, overdraft 3, replay 10.

## Resultados (janela de medição)
| operação | requisições | req/s | p50 ms | p95 ms | p99 ms | máx ms | erro |
|---|---|---|---|---|---|---|---|
| **total** | 13313 | 443.0 | 67.7 | 109.8 | 153.4 | 237.8 | 0.00% |
| bet | 7632 | 254.0 | 68.9 | 111.2 | 156.9 | 237.8 | 0.00% |
| win | 2230 | 74.2 | 68.7 | 109.1 | 154.3 | 226.4 | 0.00% |
| hot_bet | 0 | 0.0 | 0.0 | 0.0 | 0.0 | 0.0 | 0.00% |
| loss | 754 | 25.1 | 64.9 | 112.4 | 160.9 | 190.8 | 0.00% |
| refund | 794 | 26.4 | 72.5 | 113.9 | 169.2 | 234.6 | 0.00% |
| overdraft | 461 | 15.3 | 65.7 | 114.4 | 169.2 | 187.5 | 0.00% |
| replay | 1442 | 48.0 | 55.2 | 88.1 | 119.7 | 181.1 | 0.00% |

- **Status HTTP:** 200: 1386 · 201: 11410 · 422: 517
- **Taxa de erro** (resposta fora do esperado para a operação, 5xx ou falha de rede): **0.000%** (0/13313; rede: 0)
- **Conflitos de concorrência:** lock timeouts/deadlocks = 0; transações re-tentadas = 0; replays idempotentes atendidos = 1638
- **Outbox lag** (amostrado a cada 500 ms): p50 0.033 s · p95 0.064 s · máx 0.466 s · drenagem final 112 ms

## Invariantes ao final
| verificação | resultado |
|---|---|
| wallets com saldo ≠ ledger | 0 |
| wallets com saldo negativo | 0 |
| transações × idempotency keys distintas | 13566 × 13566 |
| transações não resolvidas (PENDING*) | 0 |
| eventos não publicados | 0 |
| lançamentos no ledger | 12364 |
