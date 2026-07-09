-- 0035: Indigo facility care_setting (IP/OP/BOTH) + remove defunct facilities.
--
-- WHY: (1) the Master Chart's IP/OP Setting filter needs Indigo facilities classified (0034
-- seeded them with NULL care_setting = "Other", so they only showed under "IP & OP"). Owner
-- provided the IP/OP split. (2) Five Indigo facilities in the roster are shut down / no longer
-- exist and carry ZERO data (verified) — remove them from the dimension (and INDIGO_CUSTOMERS).
--
-- NEW care_setting value 'BOTH': five Indigo facilities operate as BOTH inpatient and
-- outpatient. The 0016 CHECK allowed only IP/OP, so relax it to (IP|OP|BOTH|null). The chart's
-- IP/OP filter treats BOTH as matching both settings (app change ships with the tenant chart UI);
-- until then a BOTH facility reads as unclassified ("Other"), shown only under "IP & OP" — safe.
--
-- PHI: none (facilities is the non-PHI reference). RLS enabled; runs as owner (bypasses RLS).
-- Idempotent: constraint swap guarded; set-based UPDATE keyed on facility_code; deletes are
-- keyed on the 5 shut-down codes (re-run = no-op once gone). DEPENDENCY: 0016, 0034.

-- (1) Relax the care_setting CHECK to allow 'BOTH'.
alter table collections.facilities drop constraint if exists facilities_care_setting_ck;
alter table collections.facilities
  add constraint facilities_care_setting_ck
  check (care_setting is null or care_setting in ('IP', 'OP', 'BOTH'));

-- (2) Classify Indigo facilities (owner-provided; MADISON + MISSOURI = IP).
update collections.facilities f set care_setting = m.cs
from (values
  -- OP
  ('10026460','OP'),('10029373','OP'),('10029528','OP'),('10031413','OP'),('10028848','OP'),
  ('10028842','OP'),('10021230','OP'),('10033859','OP'),('10032291','OP'),('10030319','OP'),
  ('10034230','OP'),('10033867','OP'),('10034901','OP'),('10031652','OP'),('10033531','OP'),
  ('10033708','OP'),('10028219','OP'),
  -- IP (incl. the two newly-added, currently-empty facilities)
  ('10023916','IP'),('10026624','IP'),('10021573','IP'),('10025950','IP'),('10028595','IP'),
  ('10026159','IP'),('10034979','IP'),('10035467','IP'),('10036020','IP'),('10036030','IP'),
  -- BOTH inpatient + outpatient
  ('10024431','BOTH'),('10026125','BOTH'),('10030095','BOTH'),('10020687','BOTH'),('10031547','BOTH')
) as m(facility_code, cs)
where f.facility_code = m.facility_code;

-- (3) Remove the 5 shut-down Indigo facilities (verified 0 rows in cmd_explorer_rows + daily_collections).
delete from collections.facilities
where facility_code in ('10034063','10035913','10032612','10029219','10034039');
