import { Body, Controller, Get, Headers, HttpCode, HttpStatus, Inject, Param, Post, Query } from '@nestjs/common';
import { z } from 'zod';
import { resolveCorrelationId } from '../../../../interface/http/correlation';
import { logContext } from '../../../../shared/application/log-context';
import { MoneySchema, UuidParam } from '../../../../interface/http/schemas';
import { ZodValidationPipe } from '../../../../interface/http/zod-validation.pipe';
import type { OpenWalletUseCase } from '../../application/open-wallet.use-case';
import type { ReconcileWalletUseCase } from '../../application/reconcile-wallet.use-case';
import { type GetWalletLedgerQuery, type GetWalletQuery, LEDGER_PAGE_MAX } from '../../application/wallet-queries';
import { GET_WALLET, GET_WALLET_LEDGER, OPEN_WALLET, RECONCILE_WALLET } from '../../wallet.tokens';

const CreateWalletBody = z.object({ playerId: UuidParam, initialBalance: MoneySchema }).strict();

const LedgerQuery = z
  .object({
    cursor: z.string().min(1).max(512).optional(),
    limit: z.coerce.number().int().min(1).max(LEDGER_PAGE_MAX).optional(),
  })
  .strict();

@Controller('wallets')
export class WalletsController {
  constructor(
    @Inject(OPEN_WALLET) private readonly openWallet: OpenWalletUseCase,
    @Inject(GET_WALLET) private readonly getWallet: GetWalletQuery,
    @Inject(GET_WALLET_LEDGER) private readonly getLedger: GetWalletLedgerQuery,
    @Inject(RECONCILE_WALLET) private readonly reconcile: ReconcileWalletUseCase,
  ) {}

  @Post()
  @HttpCode(HttpStatus.CREATED)
  create(
    @Body(new ZodValidationPipe(CreateWalletBody)) body: z.infer<typeof CreateWalletBody>,
    @Headers('x-correlation-id') correlationId?: string,
  ) {
    return this.openWallet.execute({ ...body, correlationId: resolveCorrelationId(correlationId) });
  }

  @Get(':walletId')
  get(@Param('walletId', new ZodValidationPipe(UuidParam)) walletId: string) {
    return this.getWallet.execute(walletId);
  }

  @Get(':walletId/ledger')
  ledger(
    @Param('walletId', new ZodValidationPipe(UuidParam)) walletId: string,
    @Query(new ZodValidationPipe(LedgerQuery)) query: z.infer<typeof LedgerQuery>,
  ) {
    return this.getLedger.execute(walletId, query);
  }

  @Post(':walletId/reconciliation')
  @HttpCode(HttpStatus.OK)
  reconciliation(
    @Param('walletId', new ZodValidationPipe(UuidParam)) walletId: string,
    @Headers('x-correlation-id') correlationId?: string,
  ) {
    logContext.enrich({ walletId });
    return this.reconcile.execute(walletId, { correlationId: resolveCorrelationId(correlationId) });
  }
}
