-- 0042 — collections.cmd_facility_aliases: CMD-text → facility_code crosswalk (non-PHI reference).
--
-- NOTE: applied to prod 2026-07-10, recorded in supabase_migrations.schema_migrations under the
-- name 0039_cmd_facility_aliases (version 20260710073420). This FILE was then renumbered to 0042
-- to deconflict with the concurrent code-intelligence block that claimed 0039–0041. The applied
-- history retains the original 0039 name (a cosmetic file↔ledger drift; the migration is
-- idempotent — create-if-not-exists + on-conflict — so a re-apply under either name is a no-op).
--
-- WHY: the Collections Explorer facility filter groups facilities by care_setting (IP/OP/BOTH)
-- via a name join cmd_explorer_rows.facility → collections.facilities.facility_name. That join is
-- exact-on-name, and BXR's CMD export text diverges from the curated dimension names, so 12 of 18
-- BXR facilities fell through to "Other" (no care_setting). The divergences are NOT uniform — a
-- trailing " LLC" (TREAT MENTAL HEALTH TEXAS LLC vs TREAT MENTAL HEALTH TEXAS), an abbreviation
-- (CALIFORNIA MENTAL HEALTH LLC vs CA MENTAL HEALTH → CAMH), a facility that appears under TWO
-- texts (LONESTAR MENTAL HEALTH and LONESTAR MENTAL HEALTH LLC, both = LSMH), and a data-entry typo
-- (TEEN MENTAL HEALTH TEXAS LLC = TREAT MENTAL HEALTH TEXAS, owner-confirmed). No single name edit
-- or regex fixes all of them (one facility_name can't equal two texts; CA≠CALIFORNIA isn't a suffix
-- rule), so this is an EXPLICIT crosswalk: each raw CMD text → the canonical facility_code. Care
-- setting is still sourced from collections.facilities (single source of truth) — this table only
-- resolves the identity, never duplicates the classification.
--
-- Only NON-name-matching texts need a row here; the 6 BXR + 30 Indigo texts that already match by
-- name are untouched. "No Facility" (a real but unassigned placeholder, ~25.7k BXR rows) is
-- DELIBERATELY absent — it is not a facility and correctly stays uncategorized ("Other").
--
-- PHI: none (facility labels only). RLS enabled; runs as owner (bypasses RLS). Idempotent: table
-- IF NOT EXISTS; policies DROP-then-CREATE; grants reapplied; seed ON CONFLICT keeps codes current.
-- Rollback (drops the table) in supabase/rollbacks/. DEPENDENCY: 0006 (collections.facilities +
-- facility_code PK), 0016/0035 (care_setting), 0003/0006 (claims_reader / claims_admin roles).

-- 1. Table -------------------------------------------------------------------
create table if not exists collections.cmd_facility_aliases (
  facility_text text primary key check (char_length(facility_text) <= 200),
  facility_code text not null references collections.facilities (facility_code),
  created_at    timestamptz not null default now()
);

-- 2. Grants (mirror collections.facilities) ----------------------------------
revoke all on collections.cmd_facility_aliases from public, anon, authenticated, service_role;
grant select on collections.cmd_facility_aliases to claims_reader;
grant all    on collections.cmd_facility_aliases to claims_admin;

-- 3. RLS (GRANTs are the real boundary; policies satisfy RLS for the two roles) ---
alter table collections.cmd_facility_aliases enable row level security;

drop policy if exists cmd_facility_aliases_reader_select on collections.cmd_facility_aliases;
create policy cmd_facility_aliases_reader_select on collections.cmd_facility_aliases
  for select to claims_reader using (true);

drop policy if exists cmd_facility_aliases_admin_all on collections.cmd_facility_aliases;
create policy cmd_facility_aliases_admin_all on collections.cmd_facility_aliases
  for all to claims_admin using (true) with check (true);

-- 4. Seed — BXR CMD-export texts that do NOT match a dimension name, → canonical code.
-- (Matched-by-name texts are absent; care_setting is inherited from facilities, never stored here.)
insert into collections.cmd_facility_aliases (facility_text, facility_code) values
  ('TREAT MENTAL HEALTH CALIFORNIA LLC', 'TREAT_CA'),       -- trailing " LLC"
  ('TREAT MENTAL HEALTH TEXAS LLC',      'TREAT_TX'),       -- trailing " LLC"
  ('TREAT MENTAL HEALTH TENNESSEE LLC',  'TREAT_TN'),       -- trailing " LLC"
  ('TREAT MENTAL HEALTH NEVADA LLC',     'TREAT_NV'),       -- trailing " LLC"
  ('TENNESSEE BEHAVIORAL HEALTH LLC',    'TBH'),            -- trailing " LLC"
  ('LOS ANGELES MENTAL HEALTH LLC',      'LAMH'),           -- trailing " LLC"
  ('KENTUCKY WELLNESS CENTER LLC',       'KWC'),            -- trailing " LLC"
  ('TELEHEALTH MH LLC',                  'TELEHEALTH_MH'),  -- trailing " LLC"
  ('CALIFORNIA MENTAL HEALTH LLC',       'CAMH'),           -- abbreviation: CALIFORNIA → CA
  ('LONESTAR MENTAL HEALTH',             'LSMH'),           -- 2nd text of LSMH (LLC variant matches by name)
  ('TEEN MENTAL HEALTH TEXAS LLC',       'TREAT_TX')        -- owner-confirmed typo of TREAT MENTAL HEALTH TEXAS
on conflict (facility_text) do update set facility_code = excluded.facility_code;
