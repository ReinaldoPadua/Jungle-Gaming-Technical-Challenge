import type { Clock } from '../../../shared/application/clock';
import type { IdGenerator } from '../../../shared/application/id-generator';
import type { Metrics } from '../../../shared/application/metrics';
import type { TransactionalRepositories, UnitOfWork } from '../../../shared/application/unit-of-work';
import { Money, type MoneyProps } from '../../../shared/domain/money';
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
import { WagerTransaction } from '../domain/wager-transaction';
import type { WagerTransactionKind } from '../domain/wager-transaction-kind';
import { ExternalTransactionConflictError, IdempotencyKeyConflictError } from './errors';
import { computePayloadHash } from './payload-hash';
import { toWagerResult, type WagerResult } from './wager.views';

export type WagerSource = 'http' | 'sqs' | 'worker';

export interface ProcessWagerCommand {
  providerId: string;
  externalTransactionId: string;
  /** fonte da verdade da idempotência (header HTTP / campo da mensagem) */
  idempotencyKey: string;
  playerId: string;
  walletId: string;
  roundId: string;
  gameId: string;
  kind: WagerTransactionKind;
  money: MoneyProps;
  referenceExternalTransactionId?: string;
  correlationId: string;
  /** messageId da mensagem SQS que originou o comando, se houver */
  causationId?: string;
  source: WagerSource;
}

/**
 * Use case ÚNICO para HTTP e SQS. Uma transação SQL:
 *
 *  1. INSERT idempotente da transação (PENDING) — ON CONFLICT DO NOTHING
 *     └─ conflito → lê a existente: mesmo payloadHash = replay; outro = 409
 *  2. SELECT wallet FOR UPDATE  (lock por wallet; ordem fixa: tx → wallet)
 *  3. resolve a referência e as reversões já aplicadas (estáveis sob o lock)
 *  4. settle() — regras puras do domínio
 *  5. grava tx, wallet, ledger e eventos na outbox
 *  6. acorda transações PENDING_REFERENCE que esperavam por esta
 *  COMMIT → só então a resposta/ack
 */
export class ProcessWagerTransactionUseCase {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly clock: Clock,
    private readonly ids: IdGenerator,
    private readonly metrics: Metrics,
    private readonly retryPolicy: ReferenceRetryPolicy,
  ) {}

  async execute(cmd: ProcessWagerCommand): Promise<WagerResult> {
    const startedAt = performance.now();
    // validações de contrato (Money, kind, referência) falham ANTES de abrir transação
    const money = Money.from(cmd.money);
    const payloadHash = computePayloadHash({ ...cmd, money });
    const transactionId = this.ids.next();

    const { result, outcome } = await this.uow.run((repos) =>
      this.process(repos, cmd, money, payloadHash, transactionId),
    );

    if (outcome === 'replay') {
      this.metrics.increment('idempotent_replays_total', { source: cmd.source });
    } else {
      this.metrics.increment('wager_transactions_total', { kind: cmd.kind, status: result.status, source: cmd.source });
    }
    this.metrics.observe('wager_processing_duration_seconds', (performance.now() - startedAt) / 1000, {
      kind: cmd.kind,
      outcome,
      source: cmd.source,
    });
    return result;
  }

  private async process(
    repos: TransactionalRepositories,
    cmd: ProcessWagerCommand,
    money: Money,
    payloadHash: string,
    transactionId: string,
  ): Promise<{ result: WagerResult; outcome: 'replay' | SettlementOutcome['type'] }> {
    const now = this.clock.now();
    // criado dentro do work: um retry do UnitOfWork recomeça de um objeto novo
    const tx = WagerTransaction.create({
      id: transactionId,
      providerId: cmd.providerId,
      externalTransactionId: cmd.externalTransactionId,
      idempotencyKey: cmd.idempotencyKey,
      payloadHash,
      walletId: cmd.walletId,
      playerId: cmd.playerId,
      roundId: cmd.roundId,
      gameId: cmd.gameId,
      kind: cmd.kind,
      money,
      referenceExternalTransactionId: cmd.referenceExternalTransactionId,
      createdAt: now,
    });

    // 1. idempotência decidida pelo banco
    if (!(await repos.wagerTransactions.tryInsert(tx, { correlationId: cmd.correlationId }))) {
      return { result: await this.replayOrConflict(repos, tx), outcome: 'replay' };
    }

    // 2. lock da wallet — serializa todas as operações desta wallet entre instâncias
    const wallet = await repos.wallets.findByIdForUpdate(tx.walletId);

    // 3. referência (mesmo provider) e reversões já aplicadas sobre ela
    const reference = tx.referenceExternalTransactionId
      ? await repos.wagerTransactions.findByProviderExternalId(tx.providerId, tx.referenceExternalTransactionId)
      : undefined;
    const reversalsOfReference = reference ? await repos.wagerTransactions.findByReferenceTransactionId(reference.id) : [];

    // 4. regras de negócio
    const outcome = settle({
      tx,
      wallet,
      reference,
      reversalsOfReference,
      ledgerEntryId: this.ids.next(),
      now,
      retryPolicy: this.retryPolicy,
    });

    // 5. persistência — mesma transação SQL
    await repos.wagerTransactions.update(tx);
    const ctx = (): EventContext => ({
      eventId: this.ids.next(),
      correlationId: cmd.correlationId,
      ...(cmd.causationId !== undefined ? { causationId: cmd.causationId } : {}),
      occurredAt: now,
    });
    const events: IntegrationEvent<unknown>[] = [];
    switch (outcome.type) {
      case 'processed':
        if (outcome.entry && wallet) {
          await repos.wallets.update(wallet);
          await repos.ledger.append(outcome.entry);
          events.push(WalletBalanceChanged.from(wallet, outcome.entry, ctx()));
        }
        events.push(WagerTransactionProcessed.from(tx, ctx()));
        break;
      case 'rejected':
        events.push(WagerTransactionRejected.from(tx, ctx()));
        break;
      case 'pending_reference':
        events.push(WagerTransactionPendingReference.from(tx, ctx()));
        break;
    }
    await repos.outbox.enqueue(...events.map((e) => OutboxMessage.enqueue(e)));

    // 6. quem esperava por esta transação é reprocessado já (worker da fase 7)
    if (tx.isTerminal()) {
      const woken = await repos.wagerTransactions.wakeDependents(tx.providerId, tx.externalTransactionId, now);
      if (woken > 0) this.metrics.increment('pending_reference_wakeups_total', {}, woken);
    }

    return { result: toWagerResult(tx, false), outcome: outcome.type };
  }

  private async replayOrConflict(repos: TransactionalRepositories, incoming: WagerTransaction): Promise<WagerResult> {
    const byKey = await repos.wagerTransactions.findByIdempotencyKey(incoming.idempotencyKey);
    if (byKey) {
      if (!byKey.matchesPayload(incoming.payloadHash)) {
        this.metrics.increment('idempotency_conflicts_total', { reason: 'payload_mismatch' });
        throw new IdempotencyKeyConflictError(incoming.idempotencyKey, byKey.id);
      }
      return toWagerResult(byKey, true);
    }
    const byExternal = await repos.wagerTransactions.findByProviderExternalId(
      incoming.providerId,
      incoming.externalTransactionId,
    );
    if (byExternal) {
      this.metrics.increment('idempotency_conflicts_total', { reason: 'external_id_reused' });
      throw new ExternalTransactionConflictError(incoming.providerId, incoming.externalTransactionId, byExternal.id);
    }
    // ON CONFLICT disparou mas a linha sumiu: impossível (transações não são excluídas)
    throw new Error(`idempotency conflict without a visible row for key ${incoming.idempotencyKey}`);
  }
}
