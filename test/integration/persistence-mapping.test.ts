/**
 * Mapeamento domínio ⇄ registros MikroORM, passando pelas constraints e
 * triggers diferidos reais (o SQL gerado pelo ORM precisa satisfazê-los).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { LockMode } from '@mikro-orm/core';
import type { MikroORM } from '@mikro-orm/postgresql';
import { Money } from '../../src/shared/domain/money';
import { Wallet } from '../../src/modules/wallet/domain/wallet';
import { WagerTransaction } from '../../src/modules/wagering/domain/wager-transaction';
import { WagerTransactionKind } from '../../src/modules/wagering/domain/wager-transaction-kind';
import { WagerTransactionStatus } from '../../src/modules/wagering/domain/wager-transaction-status';
import { DEFAULT_REFERENCE_RETRY_POLICY } from '../../src/modules/wagering/domain/reference-retry-policy';
import { settle } from '../../src/modules/wagering/domain/wager-settlement';
import { WagerTransactionProcessed } from '../../src/modules/wagering/domain/events';
import { computePayloadHash } from '../../src/modules/wagering/application/payload-hash';
import { OutboxMessage } from '../../src/modules/messaging/domain/outbox-message';
import { InboxMessage } from '../../src/modules/messaging/domain/inbox-message';
import { WalletMapper, WalletRecord } from '../../src/modules/wallet/infrastructure/persistence/wallet.record';
import { LedgerEntryMapper, LedgerEntryRecord } from '../../src/modules/wallet/infrastructure/persistence/ledger-entry.record';
import {
  WagerTransactionMapper,
  WagerTransactionRecord,
} from '../../src/modules/wagering/infrastructure/persistence/wager-transaction.record';
import { OutboxMessageMapper, OutboxMessageRecord } from '../../src/modules/messaging/infrastructure/persistence/outbox-message.record';
import { InboxMessageMapper, InboxMessageRecord } from '../../src/modules/messaging/infrastructure/persistence/inbox-message.record';
import { initOrm } from '../helpers/infra';
import { migrateFresh, truncateAll, uuid } from '../helpers/db';

let orm: MikroORM;
beforeAll(async () => {
  orm = await initOrm();
  await migrateFresh(orm);
});
afterAll(async () => {
  await orm?.close(true);
});
beforeEach(async () => {
  await truncateAll(orm);
});

const brl = (amount: string) => Money.from({ amount, currency: 'BRL' });

async function openWallet(initial: string) {
  const at = new Date();
  const opening = WagerTransaction.createOpening({ id: uuid(), walletId: uuid(), playerId: uuid(), money: brl(initial), at });
  const { wallet, openingEntry } = Wallet.open({
    id: opening.walletId,
    playerId: opening.playerId,
    initialBalance: brl(initial),
    openingTransactionId: opening.id,
    openingEntryId: uuid(),
    at,
  });
  await orm.em.fork().transactional(async (em) => {
    // ordem explícita de inserção: transação → wallet → ledger (FKs compostas)
    em.persist(WagerTransactionMapper.toRecord(opening));
    await em.flush();
    em.persist(WalletMapper.toRecord(wallet));
    await em.flush();
    em.persist(LedgerEntryMapper.toRecord(openingEntry!));
  });
  return wallet;
}

describe('persistence mapping', () => {
  test('abertura persiste e reidrata com Money exato', async () => {
    const wallet = await openWallet('1000.00');
    const em = orm.em.fork();
    const record = await em.findOneOrFail(WalletRecord, wallet.id);
    expect(typeof record.balanceAmount).toBe('string');
    const loaded = WalletMapper.toDomain(record);
    expect(loaded.balance.toJSON()).toEqual({ amount: '1000.00', currency: 'BRL' });
    expect(loaded.version).toBe(1);

    const entries = (await em.find(LedgerEntryRecord, { walletId: wallet.id })).map(LedgerEntryMapper.toDomain);
    expect(entries).toHaveLength(1);
    expect(entries[0]!.isBalanced()).toBe(true);
    expect(entries[0]!.sequence).toBe(1);
  });

  test('BET via settle() + Unit of Work: tx, wallet, ledger, outbox e inbox no mesmo commit', async () => {
    const opened = await openWallet('100.00');
    const now = new Date();
    const payload = {
      providerId: 'provider-a', externalTransactionId: `ext-${uuid()}`, playerId: opened.playerId, walletId: opened.id,
      roundId: 'round-1', gameId: 'fortune-chimp', kind: WagerTransactionKind.Bet, money: brl('25.00'),
    };
    const bet = WagerTransaction.create({
      ...payload, id: uuid(), idempotencyKey: `${payload.providerId}:${payload.externalTransactionId}`,
      payloadHash: computePayloadHash(payload), createdAt: now,
    });

    await orm.em.fork().transactional(async (em) => {
      const txRecord = WagerTransactionMapper.toRecord(bet, undefined, { correlationId: 'corr-1' });
      em.persist(txRecord);
      em.persist(InboxMessageMapper.toRecord(InboxMessage.receive({ messageId: 'msg-1', consumerName: 'test', payloadHash: bet.payloadHash, receivedAt: now })));
      await em.flush(); // INSERT PENDING (o trigger exige)

      const walletRecord = await em.findOneOrFail(WalletRecord, opened.id, { lockMode: LockMode.PESSIMISTIC_WRITE });
      const wallet = WalletMapper.toDomain(walletRecord);
      const outcome = settle({
        tx: bet, wallet, reference: undefined, reversalsOfReference: [], ledgerEntryId: uuid(), now,
        retryPolicy: DEFAULT_REFERENCE_RETRY_POLICY,
      });
      expect(outcome.type).toBe('processed');
      if (outcome.type !== 'processed') return;

      WagerTransactionMapper.toRecord(bet, txRecord);
      WalletMapper.toRecord(wallet, walletRecord);
      await em.flush(); // UPDATE tx + wallet
      em.persist(LedgerEntryMapper.toRecord(outcome.entry!));
      em.persist(OutboxMessageMapper.toRecord(OutboxMessage.enqueue(WagerTransactionProcessed.from(bet, { eventId: uuid(), correlationId: 'corr-1', occurredAt: now }))));
    });

    const em = orm.em.fork();
    const tx = WagerTransactionMapper.toDomain(await em.findOneOrFail(WagerTransactionRecord, bet.id));
    expect(tx.status).toBe(WagerTransactionStatus.Processed);
    expect(tx.resultBalance!.amount).toBe('75.00');
    expect(tx.matchesPayload(bet.payloadHash)).toBe(true);
    const wallet = WalletMapper.toDomain(await em.findOneOrFail(WalletRecord, opened.id));
    expect(wallet.balance.amount).toBe('75.00');
    expect(wallet.version).toBe(2);
    const outbox = (await em.find(OutboxMessageRecord, {})).map(OutboxMessageMapper.toDomain);
    expect(outbox.map((o) => o.eventType)).toEqual(['WagerTransactionProcessed']);
    expect(outbox[0]!.isPending()).toBe(true);
    expect((await em.find(InboxMessageRecord, {})).length).toBe(1);

    // invariante final
    const entries = (await em.find(LedgerEntryRecord, { walletId: opened.id }, { orderBy: { sequence: 'asc' } })).map(LedgerEntryMapper.toDomain);
    const rebuilt = entries.reduce((acc, e) => acc.add(e.signedAmount()), Money.zero('BRL'));
    expect(rebuilt.equals(wallet.balance)).toBe(true);
  });

  test('atomicidade: erro depois do ledger desfaz tx, wallet, ledger, inbox e outbox', async () => {
    const opened = await openWallet('100.00');
    const before = await orm.em.fork().count(LedgerEntryRecord, {});
    await expect(
      orm.em.fork().transactional(async (em) => {
        em.persist(InboxMessageMapper.toRecord(InboxMessage.receive({ messageId: 'm', consumerName: 'test', payloadHash: 'h', receivedAt: new Date() })));
        await em.flush();
        const w = await em.findOneOrFail(WalletRecord, opened.id);
        w.balanceAmount = '90.00';
        w.version = 2;
        await em.flush();
        throw new Error('crash simulado antes do commit');
      }),
    ).rejects.toThrow('crash simulado');
    const em = orm.em.fork();
    expect((await em.findOneOrFail(WalletRecord, opened.id)).balanceAmount).toBe('100.00');
    expect(await em.count(InboxMessageRecord, {})).toBe(0);
    expect(await em.count(LedgerEntryRecord, {})).toBe(before);
  });
});
