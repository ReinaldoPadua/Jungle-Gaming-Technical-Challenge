import type { Money } from '../../../shared/domain/money';
import type { Wallet } from '../domain/wallet';
import type { WalletLedgerEntry } from '../domain/wallet-ledger-entry';

export interface WalletRepository {
  findById(id: string): Promise<Wallet | undefined>;
  /** SELECT … FOR UPDATE — só dentro de UnitOfWork. Unidade de concorrência = wallet. */
  findByIdForUpdate(id: string): Promise<Wallet | undefined>;
  /** @throws WalletAlreadyExistsError se já existe wallet para (player, moeda) */
  insert(wallet: Wallet): Promise<void>;
  update(wallet: Wallet): Promise<void>;
}

export interface LedgerPageQuery {
  walletId: string;
  /** retorna lançamentos com sequence < beforeSequence (paginação do mais novo ao mais antigo) */
  beforeSequence?: number;
  limit: number;
}

export interface LedgerSummary {
  /** Σ créditos − Σ débitos */
  calculatedBalance: Money;
  entries: number;
  lastBalanceAfter: Money | undefined;
  /** lançamentos cujo balance_before/sequence não continuam o anterior */
  chainBreaks: number;
}

export interface LedgerRepository {
  append(entry: WalletLedgerEntry): Promise<void>;
  page(query: LedgerPageQuery): Promise<WalletLedgerEntry[]>;
  summarize(walletId: string, currency: string): Promise<LedgerSummary>;
}
