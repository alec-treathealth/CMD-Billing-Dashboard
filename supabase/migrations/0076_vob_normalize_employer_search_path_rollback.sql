-- 0076 ROLLBACK — unpin search_path on vob.normalize_employer.
--
-- Restores the pre-0076 state (no proconfig entry), which is the state the Supabase security linter
-- flags as 0011_function_search_path_mutable. Only roll back if pinning is somehow implicated in a
-- resolution failure — the function body calls pg_catalog builtins only, so that should not happen.

alter function vob.normalize_employer(text) reset search_path;
