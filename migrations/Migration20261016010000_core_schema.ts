import { Migration } from '@mikro-orm/migrations';

/**
 * Schema financeiro. As invariantes críticas vivem AQUI, não só no código:
 *
 *  wallets               saldo ≥ 0, uma wallet por (player, moeda), version só muda com o saldo,
 *                        toda mudança de saldo tem lançamento (constraint trigger diferido)
 *  wager_transactions    idempotência (2 chaves únicas), estados terminais imutáveis,
 *                        referência no mesmo escopo (FK composta), reversão única (índice parcial)
 *  wallet_ledger_entries append-only, aritmética do lançamento, cadeia contínua por wallet,
 *                        valor/moeda/wallet idênticos aos da transação (FK composta)
 *  inbox_messages        dedup por (consumer_name, message_id)
 *  outbox_messages       envelope imutável; published_at definitivo
 *
 * Erros levantados pelos triggers usam SQLSTATE de integridade (23xxx) para que a
 * aplicação os trate como violação de constraint, nunca como erro transitório.
 */
export class Migration20261016010000_core_schema extends Migration {
  override async up(): Promise<void> {
    for (const sql of UP) this.addSql(sql);
  }

  override async down(): Promise<void> {
    for (const sql of DOWN) this.addSql(sql);
  }
}

const KINDS = `'OPENING','BET','WIN','LOSS','REFUND','ROLLBACK'`;
const STATUSES = `'PENDING','PENDING_REFERENCE','PROCESSED','REJECTED','FAILED'`;
const FAILURE_CODES = [
  'INSUFFICIENT_FUNDS', 'REVERSAL_WOULD_OVERDRAW', 'WALLET_NOT_FOUND', 'WALLET_PLAYER_MISMATCH',
  'CURRENCY_MISMATCH', 'REFERENCE_NOT_FOUND', 'REFERENCE_MISMATCH', 'REFERENCE_INVALID_KIND',
  'REFERENCE_NOT_PROCESSED', 'REFERENCE_AMOUNT_MISMATCH', 'ALREADY_REVERSED', 'INFRA_PERMANENT_FAILURE',
].map((c) => `'${c}'`).join(',');

const UP: string[] = [
  // ======================================================================= wallets
  `create table wallets (
    id              uuid          primary key,
    player_id       uuid          not null,
    currency        char(3)       not null,
    balance_amount  numeric(20,2) not null,
    version         integer       not null,
    created_at      timestamptz   not null,
    updated_at      timestamptz   not null,
    constraint wallets_currency_format    check (currency ~ '^[A-Z]{3}$'),
    constraint wallets_balance_non_negative check (balance_amount >= 0),
    constraint wallets_version_positive   check (version >= 1),
    constraint wallets_player_currency_uq unique (player_id, currency),
    -- alvo da FK composta do ledger (garante moeda do lançamento = moeda da wallet)
    constraint wallets_id_currency_uq     unique (id, currency)
  )`,

  `create function wallets_guard() returns trigger language plpgsql as $$
  begin
    if tg_op = 'DELETE' then
      raise exception 'wallets cannot be deleted' using errcode = 'restrict_violation';
    end if;
    if tg_op = 'INSERT' then
      if new.version <> 1 then
        raise exception 'wallet must be created with version 1' using errcode = 'check_violation';
      end if;
      return new;
    end if;
    if new.id <> old.id or new.player_id <> old.player_id or new.currency <> old.currency
       or new.created_at <> old.created_at then
      raise exception 'wallet identity columns are immutable' using errcode = 'restrict_violation';
    end if;
    if new.balance_amount <> old.balance_amount and new.version <> old.version + 1 then
      raise exception 'wallet version must increment by exactly 1 when the balance changes (% -> %)',
        old.version, new.version using errcode = 'check_violation';
    end if;
    if new.balance_amount = old.balance_amount and new.version <> old.version then
      raise exception 'wallet version can only change together with the balance' using errcode = 'check_violation';
    end if;
    return new;
  end $$`,
  `create trigger wallets_guard before insert or update or delete on wallets
     for each row execute function wallets_guard()`,

  // ============================================================ wager_transactions
  `create table wager_transactions (
    id                                 uuid          primary key,
    provider_id                        varchar(64)   not null,
    external_transaction_id            varchar(128)  not null,
    idempotency_key                    varchar(256)  not null,
    payload_hash                       varchar(64)   not null,
    -- sem FK para wallets: transações para wallet inexistente são REJECTED e auditáveis
    wallet_id                          uuid          not null,
    player_id                          uuid          not null,
    round_id                           varchar(128)  not null,
    game_id                            varchar(128)  not null,
    kind                               varchar(16)   not null,
    amount                             numeric(20,2) not null,
    currency                           char(3)       not null,
    reference_external_transaction_id  varchar(128),
    reference_transaction_id           uuid,
    status                             varchar(24)   not null,
    failure_code                       varchar(48),
    result_balance_amount              numeric(20,2),
    result_balance_currency            char(3),
    attempts                           integer       not null default 0,
    next_attempt_at                    timestamptz,
    correlation_id                     varchar(128),
    processed_at                       timestamptz,
    created_at                         timestamptz   not null,
    updated_at                         timestamptz   not null,

    constraint wtx_kind_valid          check (kind in (${KINDS})),
    constraint wtx_status_valid        check (status in (${STATUSES})),
    constraint wtx_failure_code_valid  check (failure_code is null or failure_code in (${FAILURE_CODES})),
    constraint wtx_currency_format     check (currency ~ '^[A-Z]{3}$'),
    constraint wtx_amount_non_negative check (amount >= 0),
    constraint wtx_amount_positive     check (kind = 'LOSS' or amount > 0),
    constraint wtx_payload_hash_format check (kind = 'OPENING' or payload_hash ~ '^[0-9a-f]{64}$'),
    constraint wtx_internal_provider   check ((provider_id = 'internal') = (kind = 'OPENING')),
    constraint wtx_reference_required  check (kind not in ('REFUND','ROLLBACK') or reference_external_transaction_id is not null),
    constraint wtx_reference_forbidden check (kind not in ('BET','OPENING') or reference_external_transaction_id is null),
    constraint wtx_no_self_reference   check (reference_transaction_id is null or reference_transaction_id <> id),
    constraint wtx_failure_iff_failed  check ((status in ('REJECTED','FAILED')) = (failure_code is not null)),
    constraint wtx_processed_complete  check (status <> 'PROCESSED'
                                              or (processed_at is not null and result_balance_amount is not null)),
    constraint wtx_reversal_resolved   check (status <> 'PROCESSED' or kind not in ('REFUND','ROLLBACK')
                                              or reference_transaction_id is not null),
    constraint wtx_pending_ref_scheduled check (status <> 'PENDING_REFERENCE' or next_attempt_at is not null),
    constraint wtx_result_balance_pair check ((result_balance_amount is null) = (result_balance_currency is null)),
    constraint wtx_result_balance_non_negative check (result_balance_amount is null or result_balance_amount >= 0),
    constraint wtx_attempts_non_negative check (attempts >= 0),

    -- idempotência: a chave do header e a identidade do provedor são únicas, cada uma por si
    constraint wtx_idempotency_key_uq  unique (idempotency_key),
    constraint wtx_provider_external_uq unique (provider_id, external_transaction_id),

    -- alvos de FKs compostas (id já é PK; estes só habilitam as FKs abaixo)
    constraint wtx_ledger_target_uq    unique (id, wallet_id, currency, amount),
    constraint wtx_scope_uq            unique (id, wallet_id, provider_id, player_id, round_id, currency),

    -- a referência pertence ao MESMO wallet/provider/player/rodada/moeda (regra 7.2)
    constraint wtx_reference_scope_fk foreign key
      (reference_transaction_id, wallet_id, provider_id, player_id, round_id, currency)
      references wager_transactions (id, wallet_id, provider_id, player_id, round_id, currency)
  )`,

  // uma transação é revertida no máximo uma vez (por qualquer tipo de reversão)
  `create unique index wtx_single_reversal_uq on wager_transactions (reference_transaction_id)
     where status = 'PROCESSED' and kind in ('REFUND','ROLLBACK')`,
  // no máximo uma OPENING por wallet
  `create unique index wtx_single_opening_uq on wager_transactions (wallet_id) where kind = 'OPENING'`,
  // worker de PENDING_REFERENCE
  `create index wtx_pending_reference_due_idx on wager_transactions (next_attempt_at)
     where status = 'PENDING_REFERENCE'`,
  // dependentes aguardando uma referência que acabou de chegar
  `create index wtx_waiting_for_reference_idx on wager_transactions (provider_id, reference_external_transaction_id)
     where status = 'PENDING_REFERENCE'`,
  // reversões já aplicadas sobre uma referência (lidas sob o lock da wallet)
  `create index wtx_reference_idx on wager_transactions (reference_transaction_id)
     where reference_transaction_id is not null`,
  `create index wtx_wallet_created_idx on wager_transactions (wallet_id, created_at)`,

  `create function wager_transactions_guard() returns trigger language plpgsql as $$
  begin
    if tg_op = 'DELETE' then
      raise exception 'wager transactions are audit records and cannot be deleted' using errcode = 'restrict_violation';
    end if;
    if tg_op = 'INSERT' then
      if new.kind <> 'OPENING' and new.status <> 'PENDING' then
        raise exception 'transactions must be inserted as PENDING (got %)', new.status using errcode = 'check_violation';
      end if;
      return new;
    end if;
    -- UPDATE
    if old.status in ('PROCESSED','REJECTED','FAILED') then
      raise exception 'transaction % is terminal (%) and cannot change', old.id, old.status
        using errcode = 'restrict_violation';
    end if;
    if new.status = 'PENDING' and old.status <> 'PENDING' then
      raise exception 'invalid transition % -> PENDING', old.status using errcode = 'check_violation';
    end if;
    if (new.id, new.provider_id, new.external_transaction_id, new.idempotency_key, new.payload_hash,
        new.wallet_id, new.player_id, new.round_id, new.game_id, new.kind, new.amount, new.currency,
        new.reference_external_transaction_id, new.created_at, new.correlation_id)
       is distinct from
       (old.id, old.provider_id, old.external_transaction_id, old.idempotency_key, old.payload_hash,
        old.wallet_id, old.player_id, old.round_id, old.game_id, old.kind, old.amount, old.currency,
        old.reference_external_transaction_id, old.created_at, old.correlation_id) then
      raise exception 'transaction request fields are immutable' using errcode = 'restrict_violation';
    end if;
    if new.attempts < old.attempts then
      raise exception 'attempts cannot decrease' using errcode = 'check_violation';
    end if;
    return new;
  end $$`,
  `create trigger wager_transactions_guard before insert or update or delete on wager_transactions
     for each row execute function wager_transactions_guard()`,

  // ========================================================== wallet_ledger_entries
  `create table wallet_ledger_entries (
    id              uuid          primary key,
    wallet_id       uuid          not null,
    transaction_id  uuid          not null,
    direction       varchar(6)    not null,
    amount          numeric(20,2) not null,
    currency        char(3)       not null,
    balance_before  numeric(20,2) not null,
    balance_after   numeric(20,2) not null,
    sequence        bigint        not null,
    created_at      timestamptz   not null,

    constraint wle_direction_valid      check (direction in ('DEBIT','CREDIT')),
    constraint wle_amount_positive      check (amount > 0),
    constraint wle_balances_non_negative check (balance_before >= 0 and balance_after >= 0),
    constraint wle_sequence_positive    check (sequence >= 1),
    constraint wle_balanced check (
      (direction = 'CREDIT' and balance_after = balance_before + amount) or
      (direction = 'DEBIT'  and balance_after = balance_before - amount)
    ),
    -- no máximo um lançamento por transação e wallet
    constraint wle_transaction_wallet_uq unique (transaction_id, wallet_id),
    -- ordem total por wallet; base do cursor de paginação
    constraint wle_wallet_sequence_uq    unique (wallet_id, sequence),
    -- moeda do lançamento = moeda da wallet
    constraint wle_wallet_fk foreign key (wallet_id, currency) references wallets (id, currency),
    -- wallet, moeda e valor do lançamento = os da transação
    constraint wle_transaction_fk foreign key (transaction_id, wallet_id, currency, amount)
      references wager_transactions (id, wallet_id, currency, amount)
  )`,
  `create trigger wle_append_only before update or delete on wallet_ledger_entries
     for each row execute function forbid_mutation()`,

  // cadeia contínua: o lançamento continua exatamente de onde o anterior parou
  `create function wle_chain_guard() returns trigger language plpgsql as $$
  declare
    prev wallet_ledger_entries%rowtype;
  begin
    select * into prev from wallet_ledger_entries
      where wallet_id = new.wallet_id order by sequence desc limit 1;
    if found then
      if new.sequence <> prev.sequence + 1 or new.balance_before <> prev.balance_after then
        raise exception 'ledger chain broken for wallet %: expected sequence % from balance %, got sequence % from %',
          new.wallet_id, prev.sequence + 1, prev.balance_after, new.sequence, new.balance_before
          using errcode = 'check_violation';
      end if;
    elsif new.balance_before <> 0 then
      raise exception 'first ledger entry of wallet % must start from zero', new.wallet_id
        using errcode = 'check_violation';
    end if;
    return new;
  end $$`,
  `create trigger wle_chain_guard before insert on wallet_ledger_entries
     for each row execute function wle_chain_guard()`,

  // verificado no COMMIT: lançamento pertence a transação PROCESSED que move saldo, na direção
  // correta, e a wallet terminou a transação SQL refletindo-o
  `create function wle_commit_check() returns trigger language plpgsql as $$
  declare
    tx  wager_transactions%rowtype;
    w   wallets%rowtype;
    expected_direction text;
  begin
    select * into tx from wager_transactions where id = new.transaction_id;
    if tx.status <> 'PROCESSED' then
      raise exception 'ledger entry % references transaction % in status %', new.id, tx.id, tx.status
        using errcode = 'check_violation';
    end if;
    expected_direction := case tx.kind
      when 'BET' then 'DEBIT'
      when 'WIN' then 'CREDIT'
      when 'REFUND' then 'CREDIT'
      when 'OPENING' then 'CREDIT'
      when 'ROLLBACK' then (
        select case e.direction when 'DEBIT' then 'CREDIT' else 'DEBIT' end
          from wallet_ledger_entries e where e.transaction_id = tx.reference_transaction_id)
      else null -- LOSS não pode ter lançamento
    end;
    if expected_direction is null or new.direction <> expected_direction then
      raise exception 'ledger entry % has direction % but % % requires %',
        new.id, new.direction, tx.kind, tx.id, coalesce(expected_direction, 'no entry')
        using errcode = 'check_violation';
    end if;
    select * into w from wallets where id = new.wallet_id;
    if w.version < new.sequence or (w.version = new.sequence and w.balance_amount <> new.balance_after) then
      raise exception 'wallet % (version %, balance %) does not reflect ledger entry % (sequence %, balance_after %)',
        w.id, w.version, w.balance_amount, new.id, new.sequence, new.balance_after
        using errcode = 'check_violation';
    end if;
    return null;
  end $$`,
  `create constraint trigger wle_commit_check after insert on wallet_ledger_entries
     deferrable initially deferred for each row execute function wle_commit_check()`,

  // verificado no COMMIT: todo saldo de wallet tem o lançamento que o produziu
  `create function wallets_commit_check() returns trigger language plpgsql as $$
  declare
    w wallets%rowtype;
  begin
    -- relê o estado final (a linha pode ter mudado de novo depois deste evento)
    select * into w from wallets where id = new.id;
    if w.version = 1 and w.balance_amount = 0 and not exists (
         select 1 from wallet_ledger_entries where wallet_id = w.id) then
      return null; -- wallet aberta com saldo zero: nenhum lançamento esperado
    end if;
    if not exists (
         select 1 from wallet_ledger_entries
          where wallet_id = w.id and sequence = w.version and balance_after = w.balance_amount) then
      raise exception 'wallet % balance % (version %) has no matching ledger entry',
        w.id, w.balance_amount, w.version using errcode = 'check_violation';
    end if;
    return null;
  end $$`,
  `create constraint trigger wallets_commit_check after insert or update on wallets
     deferrable initially deferred for each row execute function wallets_commit_check()`,

  `create index wle_transaction_idx on wallet_ledger_entries (transaction_id)`,

  // ================================================================ inbox / outbox
  `create table inbox_messages (
    consumer_name  varchar(64)  not null,
    message_id     varchar(128) not null,
    payload_hash   varchar(64)  not null,
    received_at    timestamptz  not null,
    processed_at   timestamptz,
    constraint inbox_messages_pk primary key (consumer_name, message_id)
  )`,

  `create table outbox_messages (
    id               uuid         primary key,
    aggregate_id     varchar(128) not null,
    event_type       varchar(64)  not null,
    payload          jsonb        not null,
    occurred_at      timestamptz  not null,
    attempts         integer      not null default 0,
    next_attempt_at  timestamptz  not null,
    locked_until     timestamptz,
    locked_by        varchar(128),
    published_at     timestamptz,
    last_error       text,
    constraint outbox_attempts_non_negative check (attempts >= 0),
    constraint outbox_payload_matches check (
      payload->>'eventId' = id::text and payload->>'eventType' = event_type
    )
  )`,
  `create index outbox_pending_due_idx on outbox_messages (next_attempt_at) where published_at is null`,
  `create function outbox_guard() returns trigger language plpgsql as $$
  begin
    if (new.id, new.aggregate_id, new.event_type, new.payload, new.occurred_at)
       is distinct from (old.id, old.aggregate_id, old.event_type, old.payload, old.occurred_at) then
      raise exception 'outbox envelope is immutable' using errcode = 'restrict_violation';
    end if;
    if old.published_at is not null and new.published_at is distinct from old.published_at then
      raise exception 'outbox message % already published', old.id using errcode = 'restrict_violation';
    end if;
    return new;
  end $$`,
  `create trigger outbox_guard before update on outbox_messages
     for each row execute function outbox_guard()`,
];

const DOWN: string[] = [
  'drop table if exists outbox_messages',
  'drop function if exists outbox_guard()',
  'drop table if exists inbox_messages',
  'drop table if exists wallet_ledger_entries',
  'drop function if exists wle_commit_check()',
  'drop function if exists wle_chain_guard()',
  'drop table if exists wager_transactions',
  'drop function if exists wager_transactions_guard()',
  'drop table if exists wallets',
  'drop function if exists wallets_commit_check()',
  'drop function if exists wallets_guard()',
];
