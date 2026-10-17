import { IsolationLevel } from '@mikro-orm/core';
import type { EntityManager, MikroORM } from '@mikro-orm/postgresql';
import { TransientError } from '../../shared/application/errors';
import type { Metrics } from '../../shared/application/metrics';
import type { TransactionalRepositories, UnitOfWork, UnitOfWorkOptions } from '../../shared/application/unit-of-work';
import { MikroInboxRepository } from '../../modules/messaging/infrastructure/persistence/mikro-inbox.repository';
import { MikroOutboxRepository } from '../../modules/messaging/infrastructure/persistence/mikro-outbox.repository';
import {
  MikroLedgerRepository,
  MikroWalletRepository,
} from '../../modules/wallet/infrastructure/persistence/mikro-wallet.repository';
import { MikroWagerTransactionRepository } from '../../modules/wagering/infrastructure/persistence/mikro-wager-transaction.repository';
import { classifyDbError, isLockConflict, sqlStateOf } from './db-errors';

export interface UnitOfWorkConfig {
  /** tentativas totais em erro transitório (1 = sem retry) */
  maxAttempts: number;
  lockTimeoutMs: number;
  statementTimeoutMs: number;
}

export const DEFAULT_UOW_CONFIG: UnitOfWorkConfig = { maxAttempts: 3, lockTimeoutMs: 2_000, statementTimeoutMs: 5_000 };

export class MikroUnitOfWork implements UnitOfWork {
  constructor(
    private readonly orm: MikroORM,
    private readonly metrics: Metrics,
    private readonly config: UnitOfWorkConfig = DEFAULT_UOW_CONFIG,
  ) {}

  async run<T>(work: (repos: TransactionalRepositories) => Promise<T>, options: UnitOfWorkOptions = {}): Promise<T> {
    for (let attempt = 1; ; attempt++) {
      try {
        // fork novo a cada tentativa: identity map limpo, nada de estado da tentativa anterior
        return await this.orm.em.fork({ clear: true }).transactional(
          async (em) => {
            await this.configureSession(em);
            return work(this.repositories(em));
          },
          {
            isolationLevel:
              options.isolation === 'repeatable read' ? IsolationLevel.REPEATABLE_READ : IsolationLevel.READ_COMMITTED,
            readOnly: options.readOnly ?? false,
          },
        );
      } catch (err) {
        if (classifyDbError(err) !== 'transient') throw err;
        if (isLockConflict(err)) this.metrics.increment('db_lock_conflicts_total', { sqlstate: sqlStateOf(err) ?? '' });
        if (attempt >= this.config.maxAttempts) {
          throw new TransientError('database temporarily unavailable or contended, retry later', 1, err);
        }
        this.metrics.increment('db_transaction_retries_total');
        await Bun.sleep(jitteredBackoff(attempt));
      }
    }
  }

  private async configureSession(em: EntityManager): Promise<void> {
    // SET LOCAL vale só para esta transação; valores inteiros vindos da config, nunca do usuário
    await em.execute(
      `set local lock_timeout = '${Math.trunc(this.config.lockTimeoutMs)}ms';
       set local statement_timeout = '${Math.trunc(this.config.statementTimeoutMs)}ms'`,
    );
  }

  private repositories(em: EntityManager): TransactionalRepositories {
    return {
      wallets: new MikroWalletRepository(em),
      ledger: new MikroLedgerRepository(em),
      wagerTransactions: new MikroWagerTransactionRepository(em),
      outbox: new MikroOutboxRepository(em),
      inbox: new MikroInboxRepository(em),
    };
  }
}

/** 20ms, 40ms, 80ms… com jitter de ±50% para desencontrar instâncias concorrentes. */
function jitteredBackoff(attempt: number): number {
  const base = 20 * 2 ** (attempt - 1);
  return Math.round(base * (0.5 + Math.random()));
}
