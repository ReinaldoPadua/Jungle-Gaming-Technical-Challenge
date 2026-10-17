import type { Clock } from '../../../shared/application/clock';
import { logContext } from '../../../shared/application/log-context';
import type { AppLogger } from '../../../shared/application/logger';
import type { IdGenerator } from '../../../shared/application/id-generator';
import type { Metrics } from '../../../shared/application/metrics';
import type { TransactionalRepositories, UnitOfWork } from '../../../shared/application/unit-of-work';
import { Money, type MoneyProps } from '../../../shared/domain/money';
import { InboxMessage } from '../../messaging/domain/inbox-message';
import type { ReferenceRetryPolicy } from '../domain/reference-retry-policy';
import type { SettlementOutcome } from '../domain/wager-settlement';
import { WagerTransaction } from '../domain/wager-transaction';
import type { WagerTransactionKind } from '../domain/wager-transaction-kind';
import { ExternalTransactionConflictError, IdempotencyKeyConflictError, InboxPayloadMismatchError } from './errors';
import { computePayloadHash } from './payload-hash';
import { SettlementService } from './settlement.service';
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

/** Metadados de entrega quando o comando vem de uma fila (inbox persistente). */
export interface DeliveryContext {
  consumerName: string;
  messageId: string;
  /** hash do conteúdo da mensagem — mesmo messageId com outro conteúdo é rejeitado */
  payloadHash: string;
}

export type ProcessOutcome = 'replay' | 'duplicate_message' | SettlementOutcome['type'];

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
 *
 * Vindo da fila, o passo 0 registra a mensagem na inbox (mesma transação):
 * redelivery do mesmo messageId devolve o resultado já confirmado sem efeito novo.
 */
export class ProcessWagerTransactionUseCase {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly clock: Clock,
    private readonly ids: IdGenerator,
    private readonly metrics: Metrics,
    retryPolicy: ReferenceRetryPolicy,
    private readonly logger?: AppLogger,
  ) {
    this.settlement = new SettlementService(ids, metrics, retryPolicy);
  }

  private readonly settlement: SettlementService;

  async execute(cmd: ProcessWagerCommand, delivery?: DeliveryContext): Promise<WagerResult> {
    return (await this.executeDetailed(cmd, delivery)).result;
  }

  /** Igual a execute(), expondo também o desfecho (usado pelo consumidor para métricas/logs). */
  async executeDetailed(
    cmd: ProcessWagerCommand,
    delivery?: DeliveryContext,
  ): Promise<{ result: WagerResult; outcome: ProcessOutcome }> {
    const startedAt = performance.now();
    // validações de contrato (Money, kind, referência) falham ANTES de abrir transação
    const money = Money.from(cmd.money);
    const payloadHash = computePayloadHash({ ...cmd, money });
    const transactionId = this.ids.next();
    logContext.enrich({ transactionId, walletId: cmd.walletId, providerId: cmd.providerId });

    const { result, outcome } = await this.uow.run(async (repos) => {
      // 0. inbox (somente entrada por fila)
      let inbox: InboxMessage | undefined;
      if (delivery) {
        const receipt = await repos.inbox.receive(
          InboxMessage.receive({ ...delivery, receivedAt: this.clock.now() }),
        );
        if (receipt.kind === 'duplicate') {
          if (receipt.existing.payloadHash !== delivery.payloadHash) {
            throw new InboxPayloadMismatchError(delivery.consumerName, delivery.messageId);
          }
          this.metrics.increment('inbox_duplicates_total', { consumer: delivery.consumerName });
          const existing = await repos.wagerTransactions.findByIdempotencyKey(cmd.idempotencyKey);
          if (!existing) throw new Error(`inbox has ${delivery.messageId} but no transaction for its idempotency key`);
          return { result: toWagerResult(existing, true), outcome: 'duplicate_message' as const };
        }
        inbox = receipt.message;
      }

      const processed = await this.process(repos, cmd, money, payloadHash, transactionId);

      if (inbox) {
        inbox.markProcessed(this.clock.now());
        await repos.inbox.markProcessed(inbox);
      }
      return processed;
    });

    // replay: o transactionId relevante é o da transação original
    logContext.enrich({ transactionId: result.transactionId });
    this.logger?.info('wager transaction handled', {
      kind: cmd.kind,
      source: cmd.source,
      outcome,
      status: result.status,
      failureCode: result.failureCode,
      idempotentReplay: result.idempotentReplay,
      durationMs: Math.round(performance.now() - startedAt),
    });

    if (outcome === 'replay' || outcome === 'duplicate_message') {
      this.metrics.increment('idempotent_replays_total', { source: cmd.source });
    } else {
      this.metrics.increment('wager_transactions_total', { kind: cmd.kind, status: result.status, source: cmd.source });
    }
    this.metrics.observe('wager_processing_duration_seconds', (performance.now() - startedAt) / 1000, {
      kind: cmd.kind,
      outcome,
      source: cmd.source,
    });
    return { result, outcome };
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

    // 2–6. lock da wallet, referência, regras, persistência, eventos, dependentes
    const outcome = await this.settlement.settleAndPersist(repos, tx, {
      now,
      correlationId: cmd.correlationId,
      causationId: cmd.causationId,
      emitPendingEvent: true,
    });

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
