import type { WagerTransaction } from '../domain/wager-transaction';

export interface WagerTransactionWriteMeta {
  correlationId?: string;
}

/** Fase 3 usa insert/findById; a fase 4 acrescenta inserção idempotente e consultas de referência. */
export interface WagerTransactionRepository {
  insert(tx: WagerTransaction, meta?: WagerTransactionWriteMeta): Promise<void>;
  update(tx: WagerTransaction): Promise<void>;
  findById(id: string): Promise<WagerTransaction | undefined>;
}
