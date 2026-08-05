-- 0085 rollback — drop the facility_assignments store and its write function.
--
-- ⚠ ORDER: 0086 (cmd_facility_resolution) reads this table. Roll back 0086 first, or the DROP
--   TABLE fails on the matview dependency.
-- ⚠ DATA LOSS: every manual assignment and its audit trail is destroyed. Export first if any
--   assignments exist:
--     select * from collections.facility_assignments order by id;  -- (contains member_id_bidx
--     tokens and operator notes — treat the export itself as sensitive.)

set role claims_admin;

drop function if exists collections.save_facility_assignments(uuid, text, text, text, jsonb);
drop trigger  if exists facility_assignments_guard on collections.facility_assignments;
drop function if exists collections.facility_assignments_guard();
drop table    if exists collections.facility_assignments;

reset role;
