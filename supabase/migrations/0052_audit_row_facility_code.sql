-- 0052: claims.audit_row.facility_code — per-row facility attribution for the Phase-3
-- facility-scoped decision resolver (Option B, Alec's ruling 2026-07-14).
--
-- APPLIED live 2026-07-14 (Alec approved the backfill map + ruling A at the HOLD).
-- Rollback: 0052_audit_row_facility_code_rollback.sql (drops column + index). 0052 was
-- unclaimed (checked origin/main + all worktrees + untracked; see veris-data-notes).
--
-- WHY (Option B, chosen over Option A office_name→facility_alias reverse-lookup): every
-- audit row must carry an authoritative facility_code so the flag engine can scope alias
-- resolution to ONE facility's decision carriers (a cross-facility payer tie — CAMH
-- "Anthem BCBS CALIFORNIA" vs Treat CA "Anthem of CALIFORNIA" — then can never mis-route).
-- GO-FORWARD: the ingest stamps facility_code from the roster's authoritative
-- CmdCustomerTarget.facilityCode at write time (auditIngest.ts) — NO office-name parsing
-- on the go-forward path; the roster is the CMD-customer→facility source of truth and each
-- BXR customer account is 1:1 with a facility (verified: 18 office_name spellings over the
-- live 24,507 rows resolve to 16 facilities-with-data, one office_name per facility modulo
-- two spelling variants; office_id is 100% NULL — never a usable key).
--
-- COLUMN IS NULLABLE ON PURPOSE: an unmapped/unrecognized office_name must be
-- representable (facility_code = NULL), never force-guessed. The Phase-3 resolver
-- FAILS CLOSED on NULL facility_code (skips decision-based flags, counts the row) — it
-- never falls back to the tenant-wide carrier set.
--
-- BACKFILL MAP — VERIFIED, dual-authority (owner-confirmed collections crosswalk
-- collections.cmd_facility_aliases + collections.facilities dimension AND the audit
-- roster src/billingAudit/auditConfig.ts), cross-checked against the live office_name
-- distribution (2026-07-14). All 18 office_name spellings map (the comma variant
-- "TREAT MENTAL HEALTH TENNESSEE, LLC" resolves to the same TREAT_TN as its no-comma
-- sibling — listed explicitly, no fuzzy normalization). Coverage: 24,507 of 24,507 rows,
-- 0 NULL.
--
-- TEEN — RESOLVED (Alec ruling A, 2026-07-14): "TEEN MENTAL HEALTH TEXAS LLC" (223 rows)
-- maps to its OWN facility_code TEEN_MH_TX, matching the audit roster's CMD customer
-- 10035166 and the go-forward stamp — NOT collections' TREAT_TX typo-merge. Rationale:
-- the audit plane reflects CMD's distinct customer identity; it is inert today
-- (billing_code_decision has NO TEEN_MH_TX rows → resolver fails closed either way), so
-- keeping the two planes' facility keys independent costs nothing and a one-line remap is
-- cheap if it later proves a genuine typo. JESS-LIST FOLLOW-UP: is 10035166 a real
-- distinct facility, or a legacy typo collections correctly merged into TREAT_TX?
--
-- IDEMPOTENT: ADD COLUMN / CREATE INDEX IF NOT EXISTS; the backfill only fills rows where
-- facility_code IS NULL, so it never clobbers a go-forward stamp and re-running is a no-op.
-- Tenant-guarded (business_entity_id = BXR) — the map is BXR office-name vocabulary.
--
-- APPLY PATH: postgres → SET ROLE claims_admin (owns claims.audit_row); same mechanism as
-- 0049/0051. New column is covered by 0049's TABLE-WIDE grants (writer insert/update,
-- reader select) — no re-grant needed.

set role claims_admin;

alter table claims.audit_row
  add column if not exists facility_code text;

comment on column claims.audit_row.facility_code is
  'Roster facility_code (CAMH, TREAT_TX, …). Stamped from CmdCustomerTarget.facilityCode '
  'at ingest (go-forward); backfilled from the verified office_name map (0052). NULL = '
  'unmapped/held — the Phase-3 resolver fails closed on NULL (no tenant-wide fallback).';

create index if not exists audit_row_facility_scope_idx
  on claims.audit_row (business_entity_id, facility_code, audit_scope);

-- Backfill: all 18 verified office_name spellings → facility_code (TEEN = TEEN_MH_TX per ruling A).
update claims.audit_row a
set facility_code = m.facility_code
from (values
  -- IP roster (both authorities agree)
  ('CALIFORNIA MENTAL HEALTH LLC',        'CAMH'),
  ('DALLAS MENTAL HEALTH LLC',            'DMH'),
  ('KENTUCKY WELLNESS CENTER LLC',        'KWC'),
  ('LONESTAR MENTAL HEALTH',              'LSMH'),
  ('LOS ANGELES MENTAL HEALTH LLC',       'LAMH'),
  ('NASHVILLE MENTAL HEALTH LLC',         'NASH'),
  ('PACIFIC COAST MENTAL HEALTH LLC',     'PCMH'),
  ('TENNESSEE BEHAVIORAL HEALTH',         'TBH'),
  ('TENNESSEE BEHAVIORAL HEALTH LLC',     'TBH'),   -- spelling variant of TBH
  -- OP roster (both authorities agree)
  ('FIRST RESPONDERS OF CALIFORNIA LLC',  'FRCA'),
  ('TEEN MENTAL HEALTH TEXAS LLC',        'TEEN_MH_TX'),  -- Alec ruling A: own facility, not collections' TREAT_TX merge (Jess follow-up)
  ('TELEHEALTH MH LLC',                   'TELEHEALTH_MH'),
  ('TREAT MENTAL HEALTH CALIFORNIA LLC',  'TREAT_CA'),
  ('TREAT MENTAL HEALTH NEVADA LLC',      'TREAT_NV'),
  ('TREAT MENTAL HEALTH TENNESSEE LLC',   'TREAT_TN'),
  ('TREAT MENTAL HEALTH TENNESSEE, LLC',  'TREAT_TN'),  -- comma variant of TREAT_TN
  ('TREAT MENTAL HEALTH TEXAS',           'TREAT_TX'),
  ('TREAT MENTAL HEALTH WASHINGTON LLC',  'TREAT_WA')
) as m(office_name, facility_code)
where a.office_name = m.office_name
  and a.facility_code is null
  and a.business_entity_id = 'af504ab6-3dcd-4aa4-a93c-27bc58de4088';

reset role;
