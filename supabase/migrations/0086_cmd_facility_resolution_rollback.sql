-- 0086 rollback — drop the resolution matview and its refresh function.
--
-- Order within the 0084-0086 family: roll THIS back first (0085 and 0084 both have dependents
-- here). The matview is a pure derivation — no data is lost that a re-apply cannot rebuild.
-- ⚠ APP CODE: the Facility Resolution page and the hourly refresh call in
--   src/collections/refreshChargeRollup.ts read/refresh this matview — revert or feature-gate
--   that code first, or the page 500s and the hourly run logs a (non-fatal) refresh failure.

drop function if exists collections.refresh_facility_resolution();
drop materialized view if exists collections.cmd_facility_resolution;
