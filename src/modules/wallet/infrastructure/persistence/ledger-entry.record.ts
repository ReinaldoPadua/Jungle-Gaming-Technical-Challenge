import { EntitySchema } from '@mikro-orm/core';
import { Money } from '../../../../shared/domain/money';
import type { LedgerDirection } from '../../domain/ledger-direction';
import { WalletLedgerEntry } from '../../domain/wallet-ledger-entry';

/** Append-only: o banco rejeita UPDATE/DELETE (trigger `wle_append_only`). */
export class LedgerEntryRecord {
  id!: string;
  walletId!: string;
  transactionId!: string;
  direction!: LedgerDirection;
  amount!: string;
  currency!: string;
  balanceBefore!: string;
  balanceAfter!: string;
  /** bigint no banco; cabe com folga em number (sequência por wallet), devolvido como string pelo driver */
  sequence!: string;
  createdAt!: Date;
}

export const LedgerEntrySchema = new EntitySchema<LedgerEntryRecord>({
  class: LedgerEntryRecord,
  tableName: 'wallet_ledger_entries',
  properties: {
    id: { type: 'uuid', primary: true },
    walletId: { type: 'uuid' },
    transactionId: { type: 'uuid' },
    direction: { type: 'string', length: 6 },
    amount: { type: 'decimal', precision: 20, scale: 2 },
    currency: { type: 'character', length: 3 },
    balanceBefore: { type: 'decimal', precision: 20, scale: 2 },
    balanceAfter: { type: 'decimal', precision: 20, scale: 2 },
    sequence: { type: 'bigint' },
    createdAt: { type: 'Date', columnType: 'timestamptz' },
  },
});

export const LedgerEntryMapper = {
  toDomain(r: LedgerEntryRecord): WalletLedgerEntry {
    const m = (amount: string) => Money.from({ amount, currency: r.currency });
    return WalletLedgerEntry.rehydrate({
      id: r.id,
      walletId: r.walletId,
      transactionId: r.transactionId,
      direction: r.direction,
      money: m(r.amount),
      balanceBefore: m(r.balanceBefore),
      balanceAfter: m(r.balanceAfter),
      sequence: Number(r.sequence),
      createdAt: r.createdAt,
    });
  },

  toRecord(e: WalletLedgerEntry): LedgerEntryRecord {
    const r = new LedgerEntryRecord();
    r.id = e.id;
    r.walletId = e.walletId;
    r.transactionId = e.transactionId;
    r.direction = e.direction;
    r.amount = e.money.amount;
    r.currency = e.money.currency;
    r.balanceBefore = e.balanceBefore.amount;
    r.balanceAfter = e.balanceAfter.amount;
    r.sequence = String(e.sequence);
    r.createdAt = e.createdAt;
    return r;
  },
};
