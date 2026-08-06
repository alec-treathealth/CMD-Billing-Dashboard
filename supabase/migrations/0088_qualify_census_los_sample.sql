-- 0088 — collections.qualify_facility_census.los_sample: the LOS side of the auth-fit sample gate.
--
-- WHY: the auth/LOS rating factor is a ratio of two averages, and until now only ONE of them could
--   be sample-gated. `auth_sample` has existed since 0078 (the count of admitted rows contributing
--   to avg_auth_days); its LOS counterpart was never stored. That asymmetry produced two concrete
--   defects, both live before this migration:
--
--   1. THE FLOOR WAS ENFORCED IN THE WRONG LAYER. With no column to read, the 3-stay minimum was
--      applied at WRITE time in qualifyCensusSync by storing avg_los_days = NULL. That collapses
--      "withheld because it is too thin to score" into "absent", one layer above where the
--      distinction is needed. The rating then emitted its newly-corrected copy —
--      "Authorized days are on file, but no length-of-stay data for this facility yet" — about a
--      facility that HAD length-of-stay data. The increment contradicted itself, and the measured
--      average was destroyed with nothing left to audit the suppression against.
--
--   2. THE AUTH SIDE HAD NO FLOOR AT ALL. avg_auth_days can be a mean of ONE value while
--      avg_los_days is a mean of twelve — measured 2026-08-05: TREAT_TX carried a single
--      Total Auth Days value across 47 admitted clients. The factor divides one by the other, so
--      the noise the LOS floor removed walked straight back in through the denominator.
--
--   With los_sample stored beside auth_sample, both are read together and the gate becomes
--   min(auth_sample, los_sample) >= 3, evaluated in ratingV2 next to the outpatient suppression —
--   i.e. the scoring decision lives in the scoring layer, and this table stores what it measured.
--
-- WHY 3: it is the LOWER tier of the repo's existing patient-count idiom
--   (app/lib/qualify/sampleGate.ts — QUALIFY_RATING_MIN_PATIENTS = 3,
--   QUALIFY_RATING_CONFIDENT_PATIENTS = 10). Reusing it keeps ONE vocabulary for "too few to score"
--   rather than minting a third threshold. The constant lives in code
--   (QUALIFY_LOS_MIN_SAMPLE, src/collections/qualifyCensus.ts), NOT in this schema: it is a scoring
--   policy that will be tuned, and a tuned threshold does not belong behind a migration.
--
-- BACKFILL POSTURE: `not null default 0`, matching auth_sample exactly. Every existing row therefore
--   reads los_sample = 0 until the next hourly :22 sync overwrites it. That is the correct
--   conservative default and not a data-loss event: 0 is below the floor, so an un-refreshed row
--   scores auth-fit as unavailable rather than confidently wrong, and the weight renormalizes away.
--   The table currently holds 2 rows and is fully rewritten every hour, so the window is one hour.
--
-- OWNERSHIP: postgres. ⚠ MEASURED — every live collections relation is relowner=postgres. Do NOT
--   add `SET ROLE claims_admin`: in this plane it downgrades the applying role from owner to
--   non-owner and fails 42501. That trap cost two failed applies on 0084/0085 (2026-08-05); the
--   generic "born owned via SET ROLE" guidance in .claude/rules/sql-migrations.md describes the
--   `claims` schema, not this one.
--
-- GRANTS: none needed. 0078 granted SELECT to claims_reader/consolidated_reader and
--   SELECT/INSERT/UPDATE/DELETE to cmd_rollup_writer at TABLE level, and a table-level grant covers
--   columns added later. Verified rather than assumed — see the verification block below.
--
-- IDEMPOTENT: ADD COLUMN IF NOT EXISTS. Re-running is a no-op, including on a database where the
--   column already exists with rows populated (the default is not re-applied to existing rows).
--
-- ROLLBACK: 0088_qualify_census_los_sample_rollback.sql. Dropping the column is safe ONLY once the
--   reading code is also rolled back — buildQualifyCensusReadQuery projects it, so a
--   code-forward/schema-back state 500s the Qualify book overview. Roll code back first.

alter table collections.qualify_facility_census
  add column if not exists los_sample integer not null default 0;

comment on column collections.qualify_facility_census.los_sample is
  'Admitted rows contributing to avg_los_days: billed (see isBilledForAuthFit) AND with a computable '
  'length of stay. Pairs with auth_sample; ratingV2 gates the auth-fit factor on '
  'min(auth_sample, los_sample) >= QUALIFY_LOS_MIN_SAMPLE. 0 = not yet resynced since 0088.';

-- ── verification (run after applying; all three must hold) ─────────────────────────────────────
--
-- 1. the column exists, is not-null, and defaults to 0
-- select column_name, data_type, is_nullable, column_default
--   from information_schema.columns
--  where table_schema = 'collections' and table_name = 'qualify_facility_census'
--    and column_name in ('auth_sample', 'los_sample')
--  order by column_name;
--   -- expect two rows, both integer / NO / 0
--
-- 2. the table-level grants from 0078 already cover the new column (nothing to add)
-- select grantee, privilege_type
--   from information_schema.role_table_grants
--  where table_schema = 'collections' and table_name = 'qualify_facility_census'
--    and grantee in ('claims_reader', 'consolidated_reader', 'cmd_rollup_writer')
--  order by grantee, privilege_type;
--   -- expect claims_reader/consolidated_reader SELECT; cmd_rollup_writer SELECT+INSERT+UPDATE+DELETE
--
-- 3. existing rows carry the conservative default until the next :22 sync
-- select facility_code, auth_sample, los_sample, avg_auth_days, avg_los_days
--   from collections.qualify_facility_census order by facility_code;
--   -- expect los_sample = 0 on every pre-existing row; non-zero after the next hourly run
