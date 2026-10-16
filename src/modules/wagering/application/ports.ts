import type { WagerTransaction } from '../domain/wager-transaction';

export interface WagerTransactionWriteMeta {
  correlationId?: string;
}

export interface WagerTransactionRepository {
  insert(tx: WagerTransaction, meta?: WagerTransactionWriteMeta): Promise<void>;
  /**
   * INSERT … ON CONFLICT DO NOTHING. `true` se esta chamada criou a linha;
   * `false` se já existia outra com a mesma idempotency_key ou o mesmo
   * (provider_id, external_transaction_id). Se uma transação concorrente está
   * inserindo a mesma chave, o Postgres espera o desfecho dela antes de decidir —
   * a unicidade é decidida pelo banco, nunca por "consultar e depois inserir".
   */
  tryInsert(tx: WagerTransaction, meta?: WagerTransactionWriteMeta): Promise<boolean>;
  update(tx: WagerTransaction): Promise<void>;
  findById(id: string): Promise<WagerTransaction | undefined>;
  findByIdempotencyKey(key: string): Promise<WagerTransaction | undefined>;
  findByProviderExternalId(providerId: string, externalTransactionId: string): Promise<WagerTransaction | undefined>;
  /** Transações que referenciam `referenceTransactionId` (reversões já resolvidas). */
  findByReferenceTransactionId(referenceTransactionId: string): Promise<WagerTransaction[]>;
  /**
   * Antecipa a próxima tentativa das transações PENDING_REFERENCE que esperam
   * por (providerId, externalTransactionId). Usa SKIP LOCKED: nunca espera por
   * linhas que o worker está processando (evita deadlock wallet ↔ pendente).
   */
  wakeDependents(providerId: string, externalTransactionId: string, now: Date): Promise<number>;
}
