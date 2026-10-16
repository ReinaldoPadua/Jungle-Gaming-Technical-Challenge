import type { EntityManager } from '@mikro-orm/postgresql';
import type { WagerTransactionRepository, WagerTransactionWriteMeta } from '../../application/ports';
import type { WagerTransaction } from '../../domain/wager-transaction';
import { WagerTransactionMapper, WagerTransactionRecord } from './wager-transaction.record';

export class MikroWagerTransactionRepository implements WagerTransactionRepository {
  constructor(private readonly em: EntityManager) {}

  async insert(tx: WagerTransaction, meta: WagerTransactionWriteMeta = {}): Promise<void> {
    this.em.persist(WagerTransactionMapper.toRecord(tx, undefined, meta));
    await this.em.flush();
  }

  async update(tx: WagerTransaction): Promise<void> {
    const record = await this.em.findOneOrFail(WagerTransactionRecord, { id: tx.id });
    WagerTransactionMapper.toRecord(tx, record);
    await this.em.flush();
  }

  async findById(id: string): Promise<WagerTransaction | undefined> {
    const r = await this.em.findOne(WagerTransactionRecord, { id });
    return r ? WagerTransactionMapper.toDomain(r) : undefined;
  }
}
