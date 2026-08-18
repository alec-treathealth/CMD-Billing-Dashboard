-- 0105 — collections.cmd_patient_directory: the bounded name index that makes a FULL-BOOK
--        patient-name search possible.
--
-- WHY (measured 2026-08-18, live):
--   The Collections name search decrypts CANDIDATE ROWS and is therefore capped at 2,000 of them
--   (CMD_NAME_SEARCH_ROW_CAP) and gated behind "narrow by facility/payer/date first". Both exist
--   only because the candidate set was ROWS. It does not need to be:
--
--     · collections.cmd_explorer_rows              686,503 rows
--     · distinct (business_entity_id, member_id_bidx)   10,941   ← 1.6% of the book
--     · member_id_bidx populated                  686,503 / 686,503 = 100.00%
--     · patient_name ciphertext                   36 MB total, avg 54.8 bytes
--
--   Decryption is NOT the bottleneck and never was: 11,000 libsodium decrypt+substring-match
--   operations measured 10-17 ms warm (~1.4 us each). The bottleneck is the CANDIDATE QUERY.
--   Computing the distinct set live costs 4,265 ms — a seq scan of all 686,503 rows plus an
--   external merge sort spilling 106 MB to disk (EXPLAIN ANALYZE, 2026-08-18) — which is why this
--   is a materialised table and not a view.
--
--   With it, a search reads ~11k rows (~1 MB), decrypts them in ~15 ms, and needs no narrowing
--   gate and no row cap at all.
--
-- WHY A TABLE AND NOT A MATERIALIZED VIEW — the constraint that shapes this whole design:
--   patient_name is libsodium `crypto_secretbox_easy` with a RANDOM PER-VALUE NONCE, so two rows
--   holding the SAME name hold DIFFERENT bytes. SQL therefore cannot dedupe names at all:
--   `distinct patient_name` returns 686,503 rows, not 10,941. The only deterministic name key is
--   the keyed HMAC (blindIndex.ts patientNameBlindIndex), which needs INDEX_HMAC_KEY and must be
--   computed in the application. So the dedup happens in Node and lands here.
--
--   `name_fp` holds EXACTLY the value collections.cmd_explorer_rows.patient_name_bidx would hold
--   for the same name — same function, same key. That is deliberate: it keeps a future precise
--   name-grain filter a join away, without a second vocabulary.
--
-- WHY THE GRAIN IS (entity, member, name) AND NOT (entity, member):
--   Members carry MORE THAN ONE distinct patient name — dependents sharing a subscriber policy.
--   Keying on the member alone would keep ONE name per member and make the others UNFINDABLE: a
--   silent miss, the one failure a search must never have. Keying on the name makes coverage
--   complete by construction.
--
--   ⚠ MEASURED AT BUILD (2026-08-18): 213 of 10,941 members = 1.95%. The pre-build ESTIMATE was
--   0.44% (6 of 1,374) and it was 4x LOW, because 1,374 was all that could be counted — it came
--   from the 7.18% of rows where patient_name_bidx happens to be populated, which is not a random
--   sample of the book. The correction strengthens this decision rather than weakening it: 213
--   real patients would have been unfindable, not ~50. Keep the measured number here; do not let
--   it drift back to the sample.
--
--   Deduping by ciphertext LENGTH instead was measured and REJECTED: it separates 5 of those 6, so
--   it trades a rigorous key for a heuristic that is wrong 1 time in 1,374 and cannot be reasoned
--   about at the call site.
--
-- SIZE: MEASURED 5,496 kB at build (11,161 rows), against a 2 MB estimate — 2.7x low. The estimate
--   priced the ciphertext and under-priced the PRIMARY KEY, which is two 64-char hex HMAC columns
--   plus a uuid and is therefore wider than the row payload it indexes. Same class of error as
--   0092 (12x on an INCLUDE payload) and 0093 (1.4x on a constant text column): PRICE THE KEY, NOT
--   JUST THE VALUES. It grows with distinct PATIENTS, not with charge lines, so 5.5 MB is the
--   shape of the whole thing, not a starting point.
--
-- PHI DISCIPLINE:
--   · patient_name is the SAME libsodium ciphertext already stored on cmd_explorer_rows — this
--     copies ciphertext, it never widens what is stored in the clear. Decryption still requires
--     LIBSODIUM_KEY, which no database role holds.
--   · member_id_bidx and name_fp are keyed HMAC tokens. The TOKEN is not PHI; its INPUT is
--     (.claude/rules/collections-crons.md). Neither is reversible without INDEX_HMAC_KEY.
--   · No name, no member id and no search term is ever stored in the clear, logged, or put in a
--     URL. The search returns member TOKENS; the grid re-queries by token.
--   · RETENTION, stated because it is a real difference from the base table: rows are never
--     deleted here, so a name CORRECTED upstream leaves its superseded ciphertext behind. The
--     writer deliberately holds no DELETE; a rebuild is an owner action (drop + re-run the CLI).
--
-- OWNERSHIP: postgres. NO `set role claims_admin` — every live collections relation is
--   relowner=postgres and a SET ROLE there DOWNGRADES the applying role and fails 42501
--   (.claude/rules/sql-migrations.md; it cost two failed applies on 0084/0085).
--
-- SECURITY / ROLE SPLIT — the two halves are deliberately different roles:
--   · claims_reader READS cmd_explorer_rows.patient_name (it is the only role with SELECT on the
--     PHI columns) and READS this table to serve a search.
--   · cmd_rollup_writer WRITES this table. It has NO select grant on patient_name and must never
--     get one; it receives already-decrypted-then-re-referenced ciphertext from the application.
--   · Neither role gets DELETE (the 0091 shape).
--
-- WHY THE WRITER POLICIES ARE PERMISSIVE (no tenant GUC): this is a cross-tenant derived index
--   rebuilt in ONE pass, exactly like collections.rollup_refresh_run (0054) — there is no single
--   business_entity_id for a run, so a `current_setting('app.business_entity_id')` WITH CHECK would
--   be the wrong shape and would force the sync to re-enter per tenant for no isolation gain. READ
--   isolation is unchanged and enforced where it always is: the reader policy is `using (true)`
--   (matching cmd_explorer_reader_select) and every application read carries
--   `business_entity_id = any($1)` from the server-derived entitlement.
--
-- IDEMPOTENT: create table/index/policy are all IF NOT EXISTS / DROP-then-CREATE; the state seed is
--   ON CONFLICT DO NOTHING. Re-running changes nothing.
--
-- DEPENDENCY: collections.cmd_explorer_rows (0019+) and its member_id_bidx column (0038).
-- Rollback: 0105_cmd_patient_directory_rollback.sql

-- 1. The directory ────────────────────────────────────────────────────────────────────────────
create table if not exists collections.cmd_patient_directory (
  business_entity_id uuid        not null,
  -- Keyed HMAC of the member id. 100% populated on the source table; this is what a name match is
  -- resolved to, and what the grid filters on (it is on the 0050 rollup and indexed by 0092).
  member_id_bidx     text        not null,
  -- Keyed HMAC of the NORMALIZED patient name — identical to what patient_name_bidx holds.
  name_fp            text        not null,
  -- One representative ciphertext for this (member, name). Decrypted in-process at search time.
  patient_name       bytea       not null,
  -- Provenance: the cmd_explorer_rows.id this name was first seen on.
  first_seen_row_id  bigint      not null,
  first_seen_at      timestamptz not null default now(),
  -- Leads with business_entity_id, per the tenant-scoped composite-index convention, so the
  -- per-tenant search read is a plain index range scan with no secondary index required.
  primary key (business_entity_id, member_id_bidx, name_fp)
);

comment on table collections.cmd_patient_directory is
  'Distinct (tenant, member, patient-name) index over collections.cmd_explorer_rows, so a patient-name '
  'search decrypts ~11k rows instead of the whole 686k-row book. Built by src/collections/patientDirectory.ts '
  '(dedup needs the HMAC, which needs INDEX_HMAC_KEY, so it cannot be a matview). Never DELETEd.';

-- 2. Sync watermark ───────────────────────────────────────────────────────────────────────────
-- A single row. The watermark MUST be stored rather than derived as max(first_seen_row_id): a batch
-- of new charge lines for patients already in the directory inserts NOTHING, so a derived watermark
-- would stall and re-scan the same rows forever.
create table if not exists collections.cmd_patient_directory_state (
  singleton      boolean     primary key default true check (singleton),
  last_row_id    bigint      not null default 0,
  rows_scanned   bigint      not null default 0,
  names_inserted bigint      not null default 0,
  refreshed_at   timestamptz not null default now(),
  -- Set only when a scan reaches the source end; batch progress alone is not freshness.
  completed_at   timestamptz
);

insert into collections.cmd_patient_directory_state (singleton) values (true)
  on conflict (singleton) do nothing;

-- 3. RLS ──────────────────────────────────────────────────────────────────────────────────────
alter table collections.cmd_patient_directory       enable row level security;
alter table collections.cmd_patient_directory_state enable row level security;

drop policy if exists cmd_patient_directory_reader_select on collections.cmd_patient_directory;
create policy cmd_patient_directory_reader_select on collections.cmd_patient_directory
  for select to claims_reader using (true);

drop policy if exists cmd_patient_directory_writer_select on collections.cmd_patient_directory;
create policy cmd_patient_directory_writer_select on collections.cmd_patient_directory
  for select to cmd_rollup_writer using (true);

drop policy if exists cmd_patient_directory_writer_insert on collections.cmd_patient_directory;
create policy cmd_patient_directory_writer_insert on collections.cmd_patient_directory
  for insert to cmd_rollup_writer with check (true);

drop policy if exists cmd_patient_directory_state_reader_select on collections.cmd_patient_directory_state;
create policy cmd_patient_directory_state_reader_select on collections.cmd_patient_directory_state
  for select to claims_reader using (true);

drop policy if exists cmd_patient_directory_state_writer_select on collections.cmd_patient_directory_state;
create policy cmd_patient_directory_state_writer_select on collections.cmd_patient_directory_state
  for select to cmd_rollup_writer using (true);

drop policy if exists cmd_patient_directory_state_writer_insert on collections.cmd_patient_directory_state;
create policy cmd_patient_directory_state_writer_insert on collections.cmd_patient_directory_state
  for insert to cmd_rollup_writer with check (true);

drop policy if exists cmd_patient_directory_state_writer_update on collections.cmd_patient_directory_state;
create policy cmd_patient_directory_state_writer_update on collections.cmd_patient_directory_state
  for update to cmd_rollup_writer using (true) with check (true);

-- 4. Grants ───────────────────────────────────────────────────────────────────────────────────
-- ⚠ A GRANT IS HALF THE GATE. Section 3 above is the other half; 0089/0090 and 0101/0102 are both
--   incidents where the grant landed without a policy and the read/write silently touched 0 rows.
grant select                 on collections.cmd_patient_directory       to claims_reader;
grant select, insert         on collections.cmd_patient_directory       to cmd_rollup_writer;
grant select                 on collections.cmd_patient_directory_state to claims_reader;
grant select, insert, update on collections.cmd_patient_directory_state to cmd_rollup_writer;

-- No DELETE to either role, deliberately (the 0091 least-privilege shape). Pruning or rebuilding
-- this table is an owner action, not something a cron can do by accident.

-- 5. Verification (run manually after apply) ─────────────────────────────────────────────────
-- ⚠ Gates 1 and 2 must BOTH be checked, and neither can be checked by SELECTing as postgres:
--   postgres is rolbypassrls, so it sees every row whether or not a policy exists.
--
--   -- gate 1: grants
--   select has_table_privilege('claims_reader','collections.cmd_patient_directory','SELECT')      as r_sel,
--          has_table_privilege('cmd_rollup_writer','collections.cmd_patient_directory','INSERT')  as w_ins,
--          has_table_privilege('cmd_rollup_writer','collections.cmd_patient_directory','DELETE')  as w_del_must_be_false,
--          has_table_privilege('claims_reader','collections.cmd_patient_directory','INSERT')      as r_ins_must_be_false;
--
--   -- gate 2: RLS is on and each role has a policy
--   select relname, relrowsecurity from pg_class
--    where oid in ('collections.cmd_patient_directory'::regclass,
--                  'collections.cmd_patient_directory_state'::regclass);
--   select tablename, policyname, roles, cmd from pg_policies
--    where schemaname='collections' and tablename like 'cmd_patient_directory%' order by 1,2;
--
--   -- seed row exists, empty directory
--   select * from collections.cmd_patient_directory_state;
--   select count(*) from collections.cmd_patient_directory;   -- 0 until the sync runs
