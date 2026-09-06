-- 035 ROLLBACK — remove the payer-alias ruling write path.
--
-- ⚠️ READ BEFORE RUNNING: THIS IS NOT SYMMETRICAL, AND IT CANNOT BE.
--
-- Dropping the function and the policy is clean — they are pure mechanism and recreate exactly.
-- The AUDIT TABLE is not, and neither are the rulings already written through it:
--
--   1. `drop table ref.payer_alias_ruling_audit` DESTROYS the only record of who ruled what, and of
--      what each row said BEFORE it was ruled. That history exists nowhere else — ref.payer_alias_map
--      keeps current state only. It is the specific thing 029 was written to make possible.
--
--   2. Rulings already applied to ref.payer_alias_map are NOT reverted here, deliberately. They are
--      attributed human judgements, not migration artifacts. Reverting them would silently un-rule
--      payer identity that Qualify is already resolving against, and would do it without attribution
--      — which is the exact act 029 forbids.
--
-- So the DEFAULT below drops the mechanism and KEEPS the record. Dropping the table is a separate,
-- commented-out step that requires a deliberate decision and, if there are rows, an export first.
--
-- Apply as: postgres → set role claims_admin (the same path 035 used).

set role claims_admin;

-- 1. The write path. After this, nothing can rule an alias — reads are unaffected.
drop function if exists ref.rule_payer_alias(text, text, text, text, text, text, text);

-- 2. The defence-in-depth UPDATE policy. Removing it does not restore any privilege; it only removes
--    the hedge described in 035's THE RLS QUESTION section.
drop policy if exists payer_alias_map_ruling_update on ref.payer_alias_map;

reset role;

-- ───────────────────────────────────────────────────────────────────────────────────────────────────
-- 3. THE AUDIT TABLE — NOT dropped by default. Uncomment ONLY with an explicit ruling.
-- ───────────────────────────────────────────────────────────────────────────────────────────────────
-- Check what you would be destroying first:
--
-- select count(*) as rulings,
--        min(ruled_at) as first_ruling,
--        max(ruled_at) as last_ruling,
--        count(distinct ruled_by) as reviewers
--   from ref.payer_alias_ruling_audit;
--
-- If that count is greater than zero, EXPORT BEFORE DROPPING. There is no second copy.
--
-- set role claims_admin;
-- drop index if exists ref.payer_alias_ruling_audit_recent_idx;
-- drop index if exists ref.payer_alias_ruling_audit_alias_idx;
-- drop policy if exists payer_alias_ruling_audit_read_all on ref.payer_alias_ruling_audit;
-- revoke select on ref.payer_alias_ruling_audit from claims_reader;
-- drop table if exists ref.payer_alias_ruling_audit;
-- reset role;
--
-- ───────────────────────────────────────────────────────────────────────────────────────────────────
-- POST-ROLLBACK VERIFICATION
-- ───────────────────────────────────────────────────────────────────────────────────────────────────
-- select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
--  where n.nspname = 'ref' and p.proname = 'rule_payer_alias';          -- expect: 0
--
-- select count(*) from pg_policies
--  where schemaname = 'ref' and tablename = 'payer_alias_map';          -- expect: 1 (read_all only)
--
-- select pg_has_role('postgres','claims_admin','SET');                   -- expect: t (still)
--
-- -- Rulings already made are INTACT and still attributed — this rollback does not un-rule them:
-- select count(*) from ref.payer_alias_map
--  where not needs_review and reviewed_by is not null;                   -- expect: unchanged
