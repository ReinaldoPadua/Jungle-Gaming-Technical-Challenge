import { Migration } from '@mikro-orm/migrations';

/**
 * Baseline: funções utilitárias reaproveitadas pelas tabelas da fase 2.
 * `forbid_mutation()` torna uma tabela append-only quando usada num trigger
 * BEFORE UPDATE OR DELETE (ledger, por exemplo).
 */
export class Migration20261016000000_baseline extends Migration {
  override async up(): Promise<void> {
    this.addSql(`
      create or replace function forbid_mutation() returns trigger
      language plpgsql as $$
      begin
        raise exception 'table "%" is append-only: % is not allowed', TG_TABLE_NAME, TG_OP
          using errcode = 'restrict_violation';
      end
      $$;
    `);
  }

  override async down(): Promise<void> {
    this.addSql('drop function if exists forbid_mutation();');
  }
}
