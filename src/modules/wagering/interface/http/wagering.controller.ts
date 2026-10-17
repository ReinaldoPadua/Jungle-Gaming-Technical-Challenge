import { Body, Controller, Get, Headers, Inject, Param, Post, Res } from '@nestjs/common';
import { resolveCorrelationId } from '../../../../interface/http/correlation';
import { logContext } from '../../../../shared/application/log-context';
import type { HttpResponse } from '../../../../interface/http/http-types';
import { UuidParam } from '../../../../interface/http/schemas';
import { ZodValidationPipe } from '../../../../interface/http/zod-validation.pipe';
import type { ProcessWagerTransactionUseCase } from '../../application/process-wager-transaction.use-case';
import type { GetWagerTransactionQuery } from '../../application/wager-queries';
import type { WagerResult } from '../../application/wager.views';
import { WagerTransactionStatus } from '../../domain/wager-transaction-status';
import { GET_WAGER, PROCESS_WAGER } from '../../wagering.tokens';
import { ExternalId, IdempotencyKeyHeader, ProviderId, WagerTransactionBody } from './wager.schemas';

/**
 * Status por desfecho (consistente com o filtro global de erros):
 *   201 PROCESSED (novo)            200 PROCESSED (replay, idempotentReplay=true)
 *   202 PENDING_REFERENCE           422 REJECTED / FAILED (novo ou replay) — corpo traz failureCode
 *   400 payload inválido            409 conflito de idempotência          503 transitório
 */
export function statusFor(result: WagerResult): number {
  switch (result.status) {
    case WagerTransactionStatus.Processed:
      return result.idempotentReplay ? 200 : 201;
    case WagerTransactionStatus.PendingReference:
    case WagerTransactionStatus.Pending:
      return 202;
    case WagerTransactionStatus.Rejected:
    case WagerTransactionStatus.Failed:
      return 422;
  }
}

@Controller()
export class WageringController {
  constructor(
    @Inject(PROCESS_WAGER) private readonly processWager: ProcessWagerTransactionUseCase,
    @Inject(GET_WAGER) private readonly queries: GetWagerTransactionQuery,
  ) {}

  @Post('wagering/transactions')
  async submit(
    @Body(new ZodValidationPipe(WagerTransactionBody)) body: WagerTransactionBody,
    @Headers('idempotency-key') idempotencyKeyHeader: string | undefined,
    @Headers('x-correlation-id') correlationId: string | undefined,
    @Res({ passthrough: true }) res: HttpResponse,
  ): Promise<WagerResult> {
    logContext.enrich({ providerId: body.providerId, walletId: body.walletId });
    // @Headers não aceita pipes: valida o header explicitamente (400 se ausente/malformado)
    const idempotencyKey = new ZodValidationPipe(IdempotencyKeyHeader).transform(idempotencyKeyHeader);
    const result = await this.processWager.execute({
      ...body,
      idempotencyKey,
      correlationId: resolveCorrelationId(correlationId),
      source: 'http',
    });
    res.status(statusFor(result));
    return result;
  }

  @Get('wagering/transactions/:transactionId')
  byId(@Param('transactionId', new ZodValidationPipe(UuidParam)) transactionId: string) {
    return this.queries.byId(transactionId);
  }

  @Get('providers/:providerId/wagering/transactions/:externalTransactionId')
  byExternalId(
    @Param('providerId', new ZodValidationPipe(ProviderId)) providerId: string,
    @Param('externalTransactionId', new ZodValidationPipe(ExternalId)) externalTransactionId: string,
  ) {
    return this.queries.byProviderExternalId(providerId, externalTransactionId);
  }
}
