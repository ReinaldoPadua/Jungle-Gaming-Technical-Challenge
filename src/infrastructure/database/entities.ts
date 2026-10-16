import { InboxMessageSchema } from '../../modules/messaging/infrastructure/persistence/inbox-message.record';
import { OutboxMessageSchema } from '../../modules/messaging/infrastructure/persistence/outbox-message.record';
import { LedgerEntrySchema } from '../../modules/wallet/infrastructure/persistence/ledger-entry.record';
import { WalletSchema } from '../../modules/wallet/infrastructure/persistence/wallet.record';
import { WagerTransactionSchema } from '../../modules/wagering/infrastructure/persistence/wager-transaction.record';

/** Lista explícita (sem discovery por glob): previsível sob Bun e em testes. */
export const ENTITY_SCHEMAS = [
  WalletSchema,
  LedgerEntrySchema,
  WagerTransactionSchema,
  InboxMessageSchema,
  OutboxMessageSchema,
];
