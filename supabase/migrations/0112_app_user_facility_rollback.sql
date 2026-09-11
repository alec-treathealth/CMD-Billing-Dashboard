-- Rollback for 0112 — claims.app_user_facility.
--
-- ⚠ DESTRUCTIVE: dropping the table DESTROYS every facility grant. Because absence means DENIAL,
--   the effect on a live `user` seat is a LOCKOUT of all tenant data, not a widening — the read
--   path treats an empty grant set as deny, never as "unrestricted". That is the safe direction to
--   fail, but it is still a visible outage for anyone holding the seat. Check for holders first:
--     select count(*) from claims.app_user where role = 'user';
--   As of 2026-09-10 that count is 0, which is why this rollback was cheap to write. It will not
--   stay cheap.
--
-- Order matters: drop the function before the table it writes, so a concurrent EXECUTE cannot
-- resolve to a definer whose target has vanished.
--
-- Idempotent: IF EXISTS throughout. Re-running converges.

set role claims_admin;

drop function if exists claims.set_app_user_facilities(uuid, text[], uuid);

drop policy if exists app_user_facility_reader_select on claims.app_user_facility;
drop policy if exists app_user_facility_admin_rw on claims.app_user_facility;

drop index if exists claims.app_user_facility_code_idx;

drop table if exists claims.app_user_facility;

reset role;
