import type { EntityManager } from '@mikro-orm/postgresql';
import type { WagerTransactionRepository, WagerTransactionWriteMeta } from '../../application/ports';
import type { WagerTransaction } from '../../domain/wager-transaction';
import { WagerTransactionMapper, WagerTransactionRecord } from './wager-transaction.record';

/** Colunas do INSERT idempotente, na ordem dos placeholders. */
const INSERT_COLUMNS = [
  'id', 'provider_id', 'external_transaction_id', 'idempotency_key', 'payload_hash', 'wallet_id', 'player_id',
  'round_id', 'game_id', 'kind', 'amount', 'currency', 'reference_external_transaction_id', 'reference_transaction_id',
  'status', 'failure_code', 'result_balance_amount', 'result_balance_currency', 'attempts', 'next_attempt_at',
  'correlation_id', 'processed_at', 'created_at', 'updated_at',
] as const;

export class MikroWagerTransactionRepository implements WagerTransactionRepository {
  constructor(private readonly em: EntityManager) {}

  async insert(tx: WagerTransaction, meta: WagerTransactionWriteMeta = {}): Promise<void> {
    this.em.persist(WagerTransactionMapper.toRecord(tx, undefined, meta));
    await this.em.flush();
  }

  async tryInsert(tx: WagerTransaction, meta: WagerTransactionWriteMeta = {}): Promise<boolean> {
    const r = WagerTransactionMapper.toRecord(tx, undefined, meta);
    const values = [
      r.id, r.providerId, r.externalTransactionId, r.idempotencyKey, r.payloadHash, r.walletId, r.playerId,
      r.roundId, r.gameId, r.kind, r.amount, r.currency, r.referenceExternalTransactionId ?? null,
      r.referenceTransactionId ?? null, r.status, r.failureCode ?? null, r.resultBalanceAmount ?? null,
      r.resultBalanceCurrency ?? null, r.attempts, r.nextAttemptAt ?? null, r.correlationId ?? null,
      r.processedAt ?? null, r.createdAt, r.updatedAt,
    ];
    // sem alvo no ON CONFLICT: cobre as duas chaves únicas (idempotency_key e provider+external)
    const rows = await this.em.execute<{ id: string }[]>(
      `insert into wager_transactions (${INSERT_COLUMNS.join(', ')})
       values (${INSERT_COLUMNS.map(() => '?').join(', ')})
       on conflict do nothing
       returning id`,
      values,
    );
    return rows.length === 1;
  }

  async update(tx: WagerTransaction): Promise<void> {
    const record = await this.em.findOneOrFail(WagerTransactionRecord, { id: tx.id });
    WagerTransactionMapper.toRecord(tx, record);
    await this.em.flush();
  }

  findById(id: string) {
    return this.one({ id });
  }

  findByIdempotencyKey(idempotencyKey: string) {
    return this.one({ idempotencyKey });
  }

  findByProviderExternalId(providerId: string, externalTransactionId: string) {
    return this.one({ providerId, externalTransactionId });
  }

  async findByReferenceTransactionId(referenceTransactionId: string): Promise<WagerTransaction[]> {
    const rows = await this.em.find(WagerTransactionRecord, { referenceTransactionId }, { refresh: true });
    return rows.map(WagerTransactionMapper.toDomain);
  }

  async wakeDependents(providerId: string, externalTransactionId: string, now: Date): Promise<number> {
    const rows = await this.em.execute<{ id: string }[]>(
      `update wager_transactions set next_attempt_at = ?
        where id in (
          select id from wager_transactions
           where status = 'PENDING_REFERENCE' and provider_id = ? and reference_external_transaction_id = ?
             and next_attempt_at > ?
           for update skip locked)
       returning id`,
      [now, providerId, externalTransactionId, now],
    );
    return rows.length;
  }

  async findDuePendingReferenceIds(now: Date, limit: number): Promise<string[]> {
    const rows = await this.em.execute<{ id: string }[]>(
      `select id from wager_transactions
        where status = 'PENDING_REFERENCE' and next_attempt_at <= ?
        order by next_attempt_at
        limit ?`,
      [now, limit],
    );
    return rows.map((r) => r.id);
  }

  async lockDuePendingReference(id: string, now: Date): Promise<WagerTransaction | undefined> {
    const rows = await this.em.execute<{ id: string }[]>(
      `select id from wager_transactions
        where id = ? and status = 'PENDING_REFERENCE' and next_attempt_at <= ?
        for update skip locked`,
      [id, now],
    );
    if (rows.length === 0) return undefined;
    return this.findById(id);
  }

  async countPendingReference(): Promise<number> {
    const [row] = await this.em.execute<{ n: string }[]>(
      `select count(*)::text as n from wager_transactions where status = 'PENDING_REFERENCE'`,
    );
    return Number(row!.n);
  }

  private async one(where: Partial<WagerTransactionRecord>): Promise<WagerTransaction | undefined> {
    // refresh: lê sempre o estado do banco (a linha pode ter sido escrita por outra transação)
    const r = await this.em.findOne(WagerTransactionRecord, where as never, { refresh: true });
    return r ? WagerTransactionMapper.toDomain(r) : undefined;
  }
}
