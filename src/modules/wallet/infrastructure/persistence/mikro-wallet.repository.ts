import { LockMode } from '@mikro-orm/core';
import type { EntityManager } from '@mikro-orm/postgresql';
import { isUniqueViolation } from '../../../../infrastructure/database/db-errors';
import { Money } from '../../../../shared/domain/money';
import type { LedgerPageQuery, LedgerRepository, LedgerSummary, WalletRepository } from '../../application/ports';
import { WalletAlreadyExistsError } from '../../application/errors';
import type { Wallet } from '../../domain/wallet';
import type { WalletLedgerEntry } from '../../domain/wallet-ledger-entry';
import { LedgerEntryMapper, LedgerEntryRecord } from './ledger-entry.record';
import { WalletMapper, WalletRecord } from './wallet.record';

/**
 * Cada escrita faz flush imediato: a ordem dos comandos SQL é a ordem das
 * chamadas do use case (necessário por causa das FKs compostas e triggers).
 * O COMMIT continua único — quem controla é o UnitOfWork.
 */
export class MikroWalletRepository implements WalletRepository {
  constructor(private readonly em: EntityManager) {}

  async findById(id: string): Promise<Wallet | undefined> {
    const r = await this.em.findOne(WalletRecord, { id });
    return r ? WalletMapper.toDomain(r) : undefined;
  }

  async findByIdForUpdate(id: string): Promise<Wallet | undefined> {
    const r = await this.em.findOne(WalletRecord, { id }, { lockMode: LockMode.PESSIMISTIC_WRITE, refresh: true });
    return r ? WalletMapper.toDomain(r) : undefined;
  }

  async insert(wallet: Wallet): Promise<void> {
    this.em.persist(WalletMapper.toRecord(wallet));
    try {
      await this.em.flush();
    } catch (err) {
      if (isUniqueViolation(err, 'wallets_player_currency_uq')) {
        throw new WalletAlreadyExistsError(wallet.playerId, wallet.currency);
      }
      throw err;
    }
  }

  async update(wallet: Wallet): Promise<void> {
    const record = await this.em.findOneOrFail(WalletRecord, { id: wallet.id });
    WalletMapper.toRecord(wallet, record);
    await this.em.flush();
  }
}

export class MikroLedgerRepository implements LedgerRepository {
  constructor(private readonly em: EntityManager) {}

  async append(entry: WalletLedgerEntry): Promise<void> {
    this.em.persist(LedgerEntryMapper.toRecord(entry));
    await this.em.flush();
  }

  async page({ walletId, beforeSequence, limit }: LedgerPageQuery): Promise<WalletLedgerEntry[]> {
    const where = beforeSequence === undefined ? { walletId } : { walletId, sequence: { $lt: String(beforeSequence) } };
    const rows = await this.em.find(LedgerEntryRecord, where, { orderBy: { sequence: 'desc' }, limit });
    return rows.map(LedgerEntryMapper.toDomain);
  }

  /** Agregação 100% no banco, em numeric: nada de somar valores em JS. */
  async summarize(walletId: string, currency: string): Promise<LedgerSummary> {
    const [row] = await this.em.execute<
      { calculated: string; entries: string; last_balance_after: string | null; chain_breaks: string }[]
    >(
      `with chain as (
         select direction, amount, balance_after, sequence,
                balance_before <> coalesce(lag(balance_after) over w, 0)               as balance_gap,
                lag(sequence) over w is not null and sequence <> lag(sequence) over w + 1 as sequence_gap
           from wallet_ledger_entries where wallet_id = ?
         window w as (order by sequence)
       )
       select coalesce(sum(case direction when 'CREDIT' then amount else -amount end), 0)::numeric(20,2)::text as calculated,
              count(*)::text                                                                               as entries,
              (select balance_after::text from chain order by sequence desc limit 1)                       as last_balance_after,
              count(*) filter (where balance_gap or sequence_gap)::text                                     as chain_breaks
         from chain`,
      [walletId],
    );
    const money = (amount: string) =>
      // soma com sinal pode ser negativa numa wallet corrompida: Money.from só aceita ≥ 0
      amount.startsWith('-') ? Money.from({ amount: amount.slice(1), currency }).negate() : Money.from({ amount, currency });
    return {
      calculatedBalance: money(row!.calculated),
      entries: Number(row!.entries),
      lastBalanceAfter: row!.last_balance_after === null ? undefined : money(row!.last_balance_after),
      chainBreaks: Number(row!.chain_breaks),
    };
  }
}
