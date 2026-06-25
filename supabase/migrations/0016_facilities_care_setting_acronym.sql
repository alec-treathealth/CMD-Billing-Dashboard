-- 0016: collections.facilities care_setting (IP/OP) + display_acronym.
--
-- WHY: the Master BXR chart's IP-vs-OP split, the Facility(IP)/Facility(OP) filters,
-- and the acronym bar labels need a DETERMINISTIC server-side reference — not a
-- client-side hardcode that can drift. This puts that classification ON the canonical
-- facilities reference, alongside facility_code/facility_name/account_number.
--
-- SINGLE SOURCE: the 15 (facility_code, care_setting, display_acronym) rows below
-- mirror src/collections/config.ts DEPOSIT_FACILITIES EXACTLY (DLMH is a display
-- relabel of facility_code DMH; TMH xx -> TREAT_xx). Do not maintain a second map —
-- the deposit-Sheet ingest and this seed are the same correspondence.
--
-- PHI: none (facilities is the non-PHI reference table; reader already has SELECT).
-- Idempotent: ADD COLUMN IF NOT EXISTS; constraint guarded by a catalog check;
-- the seed is a set-based UPDATE keyed on facility_code (re-running is a no-op).
-- care_setting is left nullable (a facility outside the canonical 15 stays NULL =
-- "Other", surfaced as such, never guessed).
--
-- DEPENDENCY: assumes 0006 (collections.facilities + the 15 seeded facilities).

alter table collections.facilities add column if not exists care_setting text;
alter table collections.facilities add column if not exists display_acronym text;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'facilities_care_setting_ck') then
    alter table collections.facilities
      add constraint facilities_care_setting_ck
      check (care_setting is null or care_setting in ('IP', 'OP'));
  end if;
end $$;

-- Seed care_setting + display_acronym for the canonical 15 (mirrors DEPOSIT_FACILITIES).
update collections.facilities f set
  care_setting = m.care_setting,
  display_acronym = m.display_acronym
from (values
  ('CAMH',          'IP', 'CAMH'),
  ('PCMH',          'IP', 'PCMH'),
  ('LAMH',          'IP', 'LAMH'),
  ('LSMH',          'IP', 'LSMH'),
  ('DMH',           'IP', 'DLMH'),
  ('TBH',           'IP', 'TBH'),
  ('NASH',          'IP', 'NASH'),
  ('KWC',           'IP', 'KWC'),
  ('TREAT_CA',      'OP', 'TMH CA'),
  ('TREAT_TN',      'OP', 'TMH TN'),
  ('TREAT_WA',      'OP', 'TMH WA'),
  ('TREAT_TX',      'OP', 'TMH TX'),
  ('TREAT_NV',      'OP', 'TMH NV'),
  ('FRCA',          'OP', 'FRCA'),
  ('TELEHEALTH_MH', 'OP', 'Telehealth MH')
) as m(facility_code, care_setting, display_acronym)
where f.facility_code = m.facility_code;
