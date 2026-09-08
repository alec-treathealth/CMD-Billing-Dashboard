-- ============================================================================================
-- ROLLBACK for Veris 037 — 835 claim + service-line grain.
--
-- 037 is additive: two new tables (indexes, grants, policies fall with them) plus ONE index on a
-- live table, era_835_payment (business_entity_id, id), added as the target of the composite
-- tenant-qualified FKs. This drops all of it and restores the schema exactly as it stood at 036.
--
-- ⚠ POPULATED-TABLE GUARD IS ACTIVE (013's pattern; Qodo #340 finding 4). Both tables are empty
--   until the era_ingest.ts emission change ships, so this is safe by default. Once rows exist,
--   dropping them discards remittance detail that has no other home — the source 835s are
--   re-downloadable, but a re-ingest is the recovery, not this script. So: a populated table
--   ABORTS the rollback unless you opt in deliberately, in the same session, after exporting:
--       SET LOCAL era835.rollback_allow_data_loss = 'on';
--
-- ⚠ staging.era_835_adjustment IS NOT TOUCHED. Its claim_line_id points at staging.claim_line — a
--   different, pre-existing table (the BILLED side, ~150,900 rows) — not at anything 037 created.
--
-- ORDER: service_line before claim (it FKs to claim); the payment index last (both children FK to
--   it). Reverse order 2BP01s.
-- ============================================================================================

set role claims_admin;

do $$
declare
  n_claim bigint := 0;
  n_line  bigint := 0;
  allow   text;
begin
  if to_regclass('staging.era_835_claim') is not null then
    execute 'select count(*) from staging.era_835_claim' into n_claim;
  end if;
  if to_regclass('staging.era_835_service_line') is not null then
    execute 'select count(*) from staging.era_835_service_line' into n_line;
  end if;
  if n_claim > 0 or n_line > 0 then
    -- current_setting(..., true) returns NULL rather than erroring when the GUC is unset.
    allow := current_setting('era835.rollback_allow_data_loss', true);
    if allow is null or lower(allow) not in ('on','true','1','yes') then
      raise exception
        '037 rollback guard: refusing to drop populated tables (era_835_claim=% rows, era_835_service_line=% rows). This discards remitted claim/line history. Export first, then re-run with: SET LOCAL era835.rollback_allow_data_loss = ''on'';',
        n_claim, n_line;
    end if;
    raise warning
      '037 rollback: dropping POPULATED tables by explicit opt-in (era_835_claim=% rows, era_835_service_line=% rows).',
      n_claim, n_line;
  end if;
end $$;

-- Child, then parent. Indexes, policies, comments and column-level grants fall with the tables.
drop table if exists staging.era_835_service_line;
drop table if exists staging.era_835_claim;

-- The one artifact that outlives the table drops: the FK-target index on the LIVE payment table.
drop index if exists staging.era_835_payment_entity_id;

reset role;

-- Verify — all three should return 0 rows:
--   select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
--    where n.nspname = 'staging' and c.relname in ('era_835_claim','era_835_service_line','era_835_payment_entity_id');
--   select policyname from pg_policies where schemaname='staging' and tablename in ('era_835_claim','era_835_service_line');
