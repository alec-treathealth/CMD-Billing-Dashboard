-- 0073 ROLLBACK: consolidated billing-audit feed columns + honest-empty recording.
--
-- ⚠ DATA LOSS: dropping the four audit_row columns discards every backfilled
-- charge_debit_id / claim_date_entered / claim_first_billed_date / cmd_customer_id value.
-- Recoverable: filter B is YTD and re-fetched nightly, so a re-apply + one consolidated
-- ingest run restores them (current-state grain).
--
-- ⚠ ORDERING: roll the CONSOLIDATED INGEST CODE back first (or disable its cron) — the
-- consolidated upsert's ON CONFLICT arbiter is the partial unique index dropped here, and
-- its run rows write scope='CONSOLIDATED', which the narrowed CHECK below rejects. The OP
-- cron is unaffected either way (fingerprint arbiter untouched; scope='OP').
--
-- The scope CHECK is restored to ('IP','OP') ONLY when no CONSOLIDATED run rows exist —
-- otherwise the ADD CONSTRAINT would fail validation; the guard RAISES with the count so
-- the operator decides (delete the run history vs keep the widened domain).

set role claims_admin;

drop index if exists claims.audit_row_entity_charge_debit_key;

alter table claims.audit_row drop column if exists charge_debit_id;
alter table claims.audit_row drop column if exists claim_date_entered;
alter table claims.audit_row drop column if exists claim_first_billed_date;
alter table claims.audit_row drop column if exists cmd_customer_id;
alter table claims.audit_row drop column if exists source_filter_id;

alter table claims.audit_ingest_run drop column if exists customers_empty;

do $$
declare
  consolidated_runs bigint;
begin
  select count(*) into consolidated_runs
  from claims.audit_ingest_run
  where scope = 'CONSOLIDATED';
  if consolidated_runs > 0 then
    raise exception
      '0073 rollback: % audit_ingest_run row(s) carry scope=CONSOLIDATED — narrowing the scope CHECK would fail. Delete/rescope that run history deliberately, or keep the widened CHECK.',
      consolidated_runs;
  end if;
  if exists (
    select 1 from pg_constraint
    where conname = 'audit_ingest_run_scope_check'
      and conrelid = 'claims.audit_ingest_run'::regclass
      and pg_get_constraintdef(oid) like '%CONSOLIDATED%'
  ) then
    alter table claims.audit_ingest_run drop constraint audit_ingest_run_scope_check;
    alter table claims.audit_ingest_run
      add constraint audit_ingest_run_scope_check
      check (scope = any (array['IP'::text, 'OP'::text]));
  end if;
end
$$;

reset role;
