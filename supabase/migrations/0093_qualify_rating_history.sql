-- 0093 — Qualify policy-rating history: daily (prefix-token × payer) rating snapshots + run-log
--        + the prefix-echo seam (smoke-shell tape, 90d delta)
--
-- WHY: nothing persists a policy rating over time — the live number (derivePolicyRating over the
--   ranking's per-facility ratingV2s) is computed per request and discarded, so "how has this
--   policy moved over 90 days" is unanswerable. The smoke-shell Qualify redesign's tape needs
--   rating-at-D vs rating-at-D-90 with the claims aggregates stored beside the number so a score's
--   movement is checkable (Alec's 90d ruling, 2026-08-08). Measured population (2026-08-08, live):
--   911 active (entity, prefix, payer) pairs in a 90d charge window; 58 with >= 3 distinct members.
--
-- PHI DISCIPLINE: no name, no raw identifier, no ciphertext. member_id_prefix_bidx is the keyed-
--   HMAC blind-index token (declared not-PHI — src/collections/blindIndex.ts:15-17, safe to
--   store/index); primary_payer/band/counts/dates are the same non-PHI aggregate vocabulary every
--   Qualify surface ships. qualify_prefix_echo stores the <=3-char uppercase alphanumeric echo of
--   an operator-typed prefix — the alphaEcho shape the UI already displays as non-PHI by doctrine
--   (app/lib/qualify/core.ts alphaEcho; phi.ts's PHI set excludes the alpha prefix). Dollar sums
--   (billed/allowed/paid) exist on the daily table for ops/audit but the tape read NEVER projects
--   them (buildPolicyTapeQuery — the buildBookKpisQuery precedent).
--
-- OWNERSHIP: postgres (this is the collections plane — NO `set role claims_admin` here; it
--   downgrades the applying role and fails 42501, the 0084/0085 lesson). The SECURITY DEFINER
--   echo function is therefore postgres-owned, which is exactly what lets claims_reader call it.
--
-- IDEMPOTENT: create table/index IF NOT EXISTS; DROP POLICY IF EXISTS before every CREATE POLICY;
--   CREATE OR REPLACE FUNCTION; GRANTs are inherently repeatable.
--
-- DEPENDENCY: 0050/0059 (cmd_explorer_charge_rollup — read by the cron, not by this file),
--   0036 (blind-index columns). Nothing here reads them at apply time, so 0093 applies cleanly on
--   its own; the cron 500s harmlessly (fail-closed) until this is applied.
--
-- SIZE ESTIMATE (honest, per the 0092 12x lesson — priced by the WIDEST TEXT columns, the token
--   [64 hex chars] and primary_payer [free text, avg ~20 bytes]): ~911 rows/day x ~200 bytes/row
--   (16 cols incl. two ~64-byte text keys) ≈ 180 KB/day ≈ 65 MB/yr heap + ~35 MB/yr for the PK
--   btree (its key carries both text columns). The 180-day backfill lands ~165k rows ≈ 33 MB + PK
--   on day one. qualify_rating_run: ~1 row/day + 180 backfill rows — noise. qualify_prefix_echo:
--   <= one row per distinct prefix (2,666 today) ≈ <1 MB. An estimate, not a promise — re-measure
--   via pg_relation_size after the first backfill run.
--
-- Rollback: 0093_qualify_rating_history_rollback.sql

-- 1. The daily snapshot table ---------------------------------------------------------------------
-- Grain: one row per ACTIVE (prefix-token, payer-label) pair per as_of date. rating/band are the
-- SAME five-factor policy rating the interactive hero shows (computed by the injected
-- computeRatingV2 + derivePolicyRating in the nightly cron — src/collections/qualifyRatingHistory.ts);
-- the aggregate columns are the claims-side inputs that fed it, stored so movement is auditable.
-- tenant_scope records the population the row was computed over (Qualify's pinned cross-tenant
-- pair) rather than a business_entity_id column: rating math (median, distinct members) does not
-- re-aggregate across entities, so the cross-tenant book is the atomic population by construction.

create table if not exists collections.qualify_policy_rating_daily (
  as_of_date              date        not null,
  member_id_prefix_bidx   text        not null,
  primary_payer           text        not null,
  tenant_scope            text        not null default 'cross-tenant-bxr-indigo',
  window_days             int         not null default 90 check (window_days between 1 and 3650),
  -- null rating = honestly suppressed (sample floor / no money evidence), never 0.
  rating                  int         null     check (rating between 0 and 100),
  band                    text        null     check (band in ('65','50','30','15','0')),
  line_count              int         not null check (line_count >= 0),
  distinct_members        int         not null check (distinct_members >= 0),
  confirmed_claims        int         not null check (confirmed_claims >= 0),
  pct_allowed             numeric(7,2)  null,
  median_days_to_payment  numeric(8,1)  null,
  facility_count          int         not null check (facility_count >= 0),
  rated_facilities        int         not null check (rated_facilities >= 0),
  billed_amount           numeric(14,2) null,
  allowed_amount          numeric(14,2) null,
  paid_amount             numeric(14,2) null,
  computed_at             timestamptz not null default now(),
  primary key (as_of_date, member_id_prefix_bidx, primary_payer)
);

-- The tape reads two dates and joins on (token, payer); the PK (as_of_date leading) already serves
-- both per-date lookups at ~911 rows/date — no secondary index is warranted yet. Add one only with
-- a measured plan in hand (0092 lesson: indexes on token+payer text are NOT cheap).

-- 2. The run-log (catch-up ledger + durability signal) ---------------------------------------------
-- One row per (run, as_of_date) attempt. ok=true rows are what the catch-up query treats as "date
-- done" — a date computing ZERO pairs still closes ok=true and never re-runs forever. A platform
-- kill leaves ok/finished_at NULL: the "started but unfinished" signal (refreshChargeRollup model).

create table if not exists collections.qualify_rating_run (
  id            bigint generated always as identity primary key,
  as_of_date    date        not null,
  started_at    timestamptz not null default now(),
  finished_at   timestamptz,
  duration_ms   int,
  ok            boolean,
  pairs_written int,
  error         text,
  triggered_by  text        not null default 'cron'
);

create index if not exists qualify_rating_run_as_of on collections.qualify_rating_run (as_of_date, ok);

-- 3. The prefix-echo seam ---------------------------------------------------------------------------
-- token -> the <=3-char display echo. DELIBERATELY EMPTY at apply time: the rollup stores tokens
-- only (no plaintext prefix exists in collections.* outside the legacy negotiation worklist), so
-- display text can only come from the interactive path, where the operator's own typed term and its
-- minted token meet. The search rewrite calls record_qualify_prefix_echo() at that meeting point;
-- until then the tape shows the token tail and honestly lacks the echo. CHECK pins the alphaEcho
-- shape (uppercase alphanumeric, 1-3 chars) so nothing longer can ever land here.

create table if not exists collections.qualify_prefix_echo (
  member_id_prefix_bidx text        primary key,
  echo                  text        not null check (echo ~ '^[A-Z0-9]{1,3}$'),
  source                text        not null default 'search',
  first_seen_at         timestamptz not null default now(),
  last_seen_at          timestamptz not null default now()
);

-- SECURITY DEFINER so the interactive path (claims_reader — a read-only role by design) can record
-- an echo without holding a table write grant. Owned by postgres (a definer runs as its OWNER —
-- and in this plane postgres owns everything). search_path pinned empty; inputs are re-validated
-- here because EXECUTE is the only gate the caller passes.
create or replace function collections.record_qualify_prefix_echo(p_token text, p_echo text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  -- Bounds: a blind-index token is 64 lowercase hex chars; the echo is the alphaEcho shape.
  if p_token is null or p_token !~ '^[0-9a-f]{64}$' then
    return; -- silently ignore malformed input: this is a best-effort display cache, never a gate
  end if;
  if p_echo is null or p_echo !~ '^[A-Z0-9]{1,3}$' then
    return;
  end if;
  insert into collections.qualify_prefix_echo (member_id_prefix_bidx, echo)
  values (p_token, p_echo)
  on conflict (member_id_prefix_bidx)
  do update set echo = excluded.echo, last_seen_at = now();
end;
$$;

revoke all on function collections.record_qualify_prefix_echo(text, text) from public;
grant execute on function collections.record_qualify_prefix_echo(text, text) to claims_reader;

-- 4. GRANTS — per-table, least privilege (0089/0091 shapes) -----------------------------------------
-- Reader: the tape read path (app Server Actions run as claims_reader).
-- Writer: the nightly cron (cmd_rollup_writer) — select/insert/update, NO delete (0091 precedent;
-- re-runs upsert in place). The cron's aggregate SCAN runs as claims_reader, which already holds
-- SELECT on cmd_explorer_charge_rollup/facilities/cmd_facility_aliases — no new grants there.

grant select on collections.qualify_policy_rating_daily to claims_reader;
grant select, insert, update on collections.qualify_policy_rating_daily to cmd_rollup_writer;

grant select on collections.qualify_rating_run to claims_reader;
grant select, insert, update on collections.qualify_rating_run to cmd_rollup_writer;

-- Identity column: the non-owner cron writer also needs privileges on its backing sequence.
do $$
declare seq text;
begin
  seq := pg_get_serial_sequence('collections.qualify_rating_run', 'id');
  if seq is not null then
    execute format('grant usage, select on sequence %s to cmd_rollup_writer', seq);
  end if;
end $$;

grant select on collections.qualify_prefix_echo to claims_reader;
grant select, insert, update on collections.qualify_prefix_echo to cmd_rollup_writer;

-- 5. RLS — a GRANT is only half the gate (the 0089/0090 lesson: no policy = silent empty reads) ----
-- Non-tenant-scoped reference/aggregate data, so using (true) is the honest qualifier. Writer
-- SELECT policies exist because the upsert's ON CONFLICT path reads the existing row (0091:109).

alter table collections.qualify_policy_rating_daily enable row level security;

drop policy if exists qprd_reader_select on collections.qualify_policy_rating_daily;
create policy qprd_reader_select on collections.qualify_policy_rating_daily
  for select to claims_reader using (true);

drop policy if exists qprd_writer_select on collections.qualify_policy_rating_daily;
create policy qprd_writer_select on collections.qualify_policy_rating_daily
  for select to cmd_rollup_writer using (true);

drop policy if exists qprd_writer_insert on collections.qualify_policy_rating_daily;
create policy qprd_writer_insert on collections.qualify_policy_rating_daily
  for insert to cmd_rollup_writer with check (true);

drop policy if exists qprd_writer_update on collections.qualify_policy_rating_daily;
create policy qprd_writer_update on collections.qualify_policy_rating_daily
  for update to cmd_rollup_writer using (true) with check (true);

alter table collections.qualify_rating_run enable row level security;

drop policy if exists qrr_reader_select on collections.qualify_rating_run;
create policy qrr_reader_select on collections.qualify_rating_run
  for select to claims_reader using (true);

drop policy if exists qrr_writer_select on collections.qualify_rating_run;
create policy qrr_writer_select on collections.qualify_rating_run
  for select to cmd_rollup_writer using (true);

drop policy if exists qrr_writer_insert on collections.qualify_rating_run;
create policy qrr_writer_insert on collections.qualify_rating_run
  for insert to cmd_rollup_writer with check (true);

drop policy if exists qrr_writer_update on collections.qualify_rating_run;
create policy qrr_writer_update on collections.qualify_rating_run
  for update to cmd_rollup_writer using (true) with check (true);

alter table collections.qualify_prefix_echo enable row level security;

drop policy if exists qpe_reader_select on collections.qualify_prefix_echo;
create policy qpe_reader_select on collections.qualify_prefix_echo
  for select to claims_reader using (true);

drop policy if exists qpe_writer_select on collections.qualify_prefix_echo;
create policy qpe_writer_select on collections.qualify_prefix_echo
  for select to cmd_rollup_writer using (true);

drop policy if exists qpe_writer_insert on collections.qualify_prefix_echo;
create policy qpe_writer_insert on collections.qualify_prefix_echo
  for insert to cmd_rollup_writer with check (true);

drop policy if exists qpe_writer_update on collections.qualify_prefix_echo;
create policy qpe_writer_update on collections.qualify_prefix_echo
  for update to cmd_rollup_writer using (true) with check (true);

-- NOTE: the SECURITY DEFINER echo function runs as postgres (BYPASSRLS), so it needs no policy of
-- its own — the function body is the gate, and its inputs are re-validated above.

-- 6. Verification (run manually after apply) --------------------------------------------------------
-- Both gates, both roles (never trust postgres-side reads for RLS — rolbypassrls):
--   select has_table_privilege('claims_reader',     'collections.qualify_policy_rating_daily', 'SELECT');          -- t
--   select has_table_privilege('cmd_rollup_writer', 'collections.qualify_policy_rating_daily', 'INSERT');          -- t
--   select has_table_privilege('cmd_rollup_writer', 'collections.qualify_policy_rating_daily', 'DELETE');          -- f
--   -- expect 4 policies per table (reader select + writer select/insert/update), 12 total:
--   select count(*) from pg_policies where schemaname = 'collections'
--     and tablename in ('qualify_policy_rating_daily','qualify_rating_run','qualify_prefix_echo');   -- 12
--   select proname, prosecdef, pg_get_userbyid(proowner) from pg_proc
--     where proname = 'record_qualify_prefix_echo';                                                   -- t, postgres
-- Then trigger the cron once (GET /api/cron/qualify-rating-history with the CRON_SECRET bearer)
-- and check the backfill landed:
--   select count(distinct as_of_date), min(as_of_date), max(as_of_date)
--     from collections.qualify_policy_rating_daily;                                                   -- ~180 dates
--   select as_of_date, ok, pairs_written, duration_ms from collections.qualify_rating_run
--     order by started_at desc limit 5;
--   select pg_size_pretty(pg_total_relation_size('collections.qualify_policy_rating_daily'));         -- vs estimate
