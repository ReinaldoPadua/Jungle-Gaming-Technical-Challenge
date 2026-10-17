import type { IdGenerator } from '../../../shared/application/id-generator';
import type { Metrics } from '../../../shared/application/metrics';
import type { TransactionalRepositories } from '../../../shared/application/unit-of-work';
import type { EventContext, IntegrationEvent } from '../../../shared/events/integration-event';
import { OutboxMessage } from '../../messaging/domain/outbox-message';
import {
  WagerTransactionPendingReference,
  WagerTransactionProcessed,
  WagerTransactionRejected,
  WalletBalanceChanged,
} from '../domain/events';
import type { ReferenceRetryPolicy } from '../domain/reference-retry-policy';
import { settle, type SettlementOutcome } from '../domain/wager-settlement';
import type { WagerTransaction } from '../domain/wager-transaction';

export interface SettlementContext {
  now: Date;
  correlationId: string;
  causationId?: string;
  /**
   * Emitir WagerTransactionPendingReference quando a transação (continua) pendente?
   * true na primeira chegada; false nos reagendamentos do worker (evita ruído).
   */
  emitPendingEvent: boolean;
}

/**
 * Passos comuns a TODAS as entradas (HTTP, fila e worker de pendentes), dentro
 * de uma transação SQL já aberta e com a linha da transação já gravada/travada:
 *
 *   lock da wallet → referência + reversões → settle() → UPDATE tx / wallet /
 *   INSERT ledger / outbox → acorda dependentes
 *
 * Ordem de locks sempre: linha da transação → wallet (sem deadlock entre entradas).
 */
export class SettlementService {
  constructor(
    private readonly ids: IdGenerator,
    private readonly metrics: Metrics,
    private readonly retryPolicy: ReferenceRetryPolicy,
  ) {}

  async settleAndPersist(repos: TransactionalRepositories, tx: WagerTransaction, ctx: SettlementContext): Promise<SettlementOutcome> {
    const { now } = ctx;

    // lock da wallet — serializa as operações desta wallet entre instâncias
    const wallet = await repos.wallets.findByIdForUpdate(tx.walletId);

    // referência (mesmo provider) e reversões já aplicadas sobre ela — estáveis sob o lock
    const reference = tx.referenceExternalTransactionId
      ? await repos.wagerTransactions.findByProviderExternalId(tx.providerId, tx.referenceExternalTransactionId)
      : undefined;
    const reversalsOfReference = reference ? await repos.wagerTransactions.findByReferenceTransactionId(reference.id) : [];

    const outcome = settle({
      tx,
      wallet,
      reference,
      reversalsOfReference,
      ledgerEntryId: this.ids.next(),
      now,
      retryPolicy: this.retryPolicy,
    });

    await repos.wagerTransactions.update(tx);
    const eventCtx = (): EventContext => ({
      eventId: this.ids.next(),
      correlationId: ctx.correlationId,
      ...(ctx.causationId !== undefined ? { causationId: ctx.causationId } : {}),
      occurredAt: now,
    });
    const events: IntegrationEvent<unknown>[] = [];
    switch (outcome.type) {
      case 'processed':
        if (outcome.entry && wallet) {
          await repos.wallets.update(wallet);
          await repos.ledger.append(outcome.entry);
          events.push(WalletBalanceChanged.from(wallet, outcome.entry, eventCtx()));
        }
        events.push(WagerTransactionProcessed.from(tx, eventCtx()));
        break;
      case 'rejected':
        events.push(WagerTransactionRejected.from(tx, eventCtx()));
        break;
      case 'pending_reference':
        if (ctx.emitPendingEvent) events.push(WagerTransactionPendingReference.from(tx, eventCtx()));
        break;
    }
    if (events.length > 0) await repos.outbox.enqueue(...events.map((e) => OutboxMessage.enqueue(e)));

    // quem esperava por esta transação tem a próxima tentativa antecipada
    if (tx.isTerminal()) {
      const woken = await repos.wagerTransactions.wakeDependents(tx.providerId, tx.externalTransactionId, now);
      if (woken > 0) this.metrics.increment('pending_reference_wakeups_total', {}, woken);
    }
    return outcome;
  }
}
