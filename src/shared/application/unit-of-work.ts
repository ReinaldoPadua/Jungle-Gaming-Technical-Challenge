import type { InboxRepository, OutboxRepository } from '../../modules/messaging/application/ports';
import type { LedgerRepository, WalletRepository } from '../../modules/wallet/application/ports';
import type { WagerTransactionRepository } from '../../modules/wagering/application/ports';

/** Repositórios vinculados a UMA transação SQL. */
export interface TransactionalRepositories {
  readonly wallets: WalletRepository;
  readonly ledger: LedgerRepository;
  readonly wagerTransactions: WagerTransactionRepository;
  readonly outbox: OutboxRepository;
  readonly inbox: InboxRepository;
}

export interface UnitOfWorkOptions {
  /** default: read committed (escritas usam lock pessimista explícito) */
  isolation?: 'read committed' | 'repeatable read';
  readOnly?: boolean;
}

/**
 * Executa `work` numa única transação SQL: tudo é confirmado junto ou nada é.
 * Erros transitórios (deadlock, serialização, lock timeout) são re-tentados
 * algumas vezes — `work` precisa ser idempotente em relação ao seu próprio
 * estado em memória (recalcula tudo a partir do banco a cada tentativa).
 */
export interface UnitOfWork {
  run<T>(work: (repos: TransactionalRepositories) => Promise<T>, options?: UnitOfWorkOptions): Promise<T>;
}

export const UNIT_OF_WORK = Symbol('UNIT_OF_WORK');
