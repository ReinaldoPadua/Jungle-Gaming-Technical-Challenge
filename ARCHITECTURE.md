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
