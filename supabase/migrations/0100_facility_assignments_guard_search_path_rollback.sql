-- 0100 ROLLBACK — unpin search_path on collections.facility_assignments_guard()
--
-- Restores the pre-0100 state (no proconfig entry: the function again inherits the caller's
-- search_path). Only reach for this if the pin somehow breaks the guard — which would mean the
-- body grew an unqualified reference; the better fix then is qualifying that reference, not
-- unpinning. NO SET ROLE (collections plane, postgres-owned).

alter function collections.facility_assignments_guard() reset search_path;

-- Verification: the proconfig query in 0100's header should now return NULL for the function.
