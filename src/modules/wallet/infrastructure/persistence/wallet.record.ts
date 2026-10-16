import { EntitySchema } from '@mikro-orm/core';
import { Money } from '../../../../shared/domain/money';
import { Wallet } from '../../domain/wallet';

/**
 * Registro de persistência. O domínio não conhece o ORM: o MikroORM mapeia
 * esta classe "burra" e os mappers convertem de/para o aggregate via
 * `Wallet.rehydrate` (que não revalida transições).
 * `numeric` é mapeado como string (`type: 'decimal'`) — nunca number.
 */
export class WalletRecord {
  id!: string;
  playerId!: string;
  currency!: string;
  balanceAmount!: string;
  version!: number;
  createdAt!: Date;
  updatedAt!: Date;
}

export const WalletSchema = new EntitySchema<WalletRecord>({
  class: WalletRecord,
  tableName: 'wallets',
  properties: {
    id: { type: 'uuid', primary: true },
    playerId: { type: 'uuid' },
    currency: { type: 'character', length: 3 },
    balanceAmount: { type: 'decimal', precision: 20, scale: 2 },
    // NÃO usa `version: true` do MikroORM: a regra "incrementa só quando o saldo muda"
    // é do domínio, e a concorrência é controlada por lock pessimista.
    version: { type: 'integer' },
    createdAt: { type: 'Date', columnType: 'timestamptz' },
    updatedAt: { type: 'Date', columnType: 'timestamptz' },
  },
});

export const WalletMapper = {
  toDomain(r: WalletRecord): Wallet {
    return Wallet.rehydrate({
      id: r.id,
      playerId: r.playerId,
      currency: r.currency,
      balance: Money.from({ amount: r.balanceAmount, currency: r.currency }),
      version: r.version,
      createdAt: r.createdAt,
      updatedAt: r.updatedAt,
    });
  },

  /** Cria um registro novo ou copia o estado do aggregate sobre um registro gerenciado. */
  toRecord(w: Wallet, target: WalletRecord = new WalletRecord()): WalletRecord {
    const s = w.toState();
    target.id = s.id;
    target.playerId = s.playerId;
    target.currency = s.currency;
    target.balanceAmount = s.balance.amount;
    target.version = s.version;
    target.createdAt = s.createdAt;
    target.updatedAt = s.updatedAt;
    return target;
  },
};
