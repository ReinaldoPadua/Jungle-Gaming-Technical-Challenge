import type { UnitOfWork } from '../../../shared/application/unit-of-work';
import { WalletNotFoundError } from './errors';
import { LedgerCursor } from './ledger-cursor';
import { toLedgerEntryView, toWalletView, type LedgerEntryView, type WalletView } from './wallet.views';

export const LEDGER_PAGE_DEFAULT = 50;
export const LEDGER_PAGE_MAX = 200;

export interface LedgerPage {
  walletId: string;
  items: LedgerEntryView[];
  /** null quando não há mais páginas */
  nextCursor: string | null;
}

export class GetWalletQuery {
  constructor(private readonly uow: UnitOfWork) {}

  async execute(walletId: string): Promise<WalletView> {
    const wallet = await this.uow.run((r) => r.wallets.findById(walletId), { readOnly: true });
    if (!wallet) throw new WalletNotFoundError(walletId);
    return toWalletView(wallet);
  }
}

export class GetWalletLedgerQuery {
  constructor(private readonly uow: UnitOfWork) {}

  /** Do lançamento mais recente para o mais antigo. */
  async execute(walletId: string, opts: { cursor?: string; limit?: number }): Promise<LedgerPage> {
    const limit = Math.min(Math.max(opts.limit ?? LEDGER_PAGE_DEFAULT, 1), LEDGER_PAGE_MAX);
    const beforeSequence = opts.cursor ? LedgerCursor.decode(opts.cursor, walletId) : undefined;

    const { exists, entries } = await this.uow.run(
      async (r) => {
        const wallet = await r.wallets.findById(walletId);
        if (!wallet) return { exists: false, entries: [] };
        // pede 1 a mais para saber se há próxima página sem um COUNT
        return { exists: true, entries: await r.ledger.page({ walletId, beforeSequence, limit: limit + 1 }) };
      },
      { readOnly: true },
    );
    if (!exists) throw new WalletNotFoundError(walletId);

    const page = entries.slice(0, limit);
    const hasMore = entries.length > limit;
    return {
      walletId,
      items: page.map(toLedgerEntryView),
      nextCursor: hasMore ? LedgerCursor.encode(walletId, page[page.length - 1]!.sequence) : null,
    };
  }
}
