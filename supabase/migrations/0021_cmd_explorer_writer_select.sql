-- 0021: let cmd_rollup_writer run the idempotent Collections Explorer upsert.
--
-- WHY: src/collections/cmdExplorerSeed.ts `insertRows` (used by BOTH the one-shot
-- seed and the daily cron, src/collections/cmdExplorerCron.ts) writes via
-- `INSERT ... ON CONFLICT (row_fingerprint) DO NOTHING`. Postgres evaluates the
-- ON CONFLICT arbiter, which requires the acting role to have (a) SELECT privilege
-- on the conflict-arbiter column AND (b) a SELECT RLS policy permitting the row.
-- Migration 0019 granted cmd_rollup_writer INSERT-only (SELECT went to claims_reader),
-- so the least-privilege cron failed first with 42501 "permission denied for table"
-- and then "new row violates row-level security policy". The seed only worked because
-- it was run with a SELECT-capable role. This migration closes that gap for the writer
-- WITHOUT widening its read access to PHI.
--
-- PHI BOUNDARY PRESERVED (docs/CLAUDE.md §2):
--   - The SELECT privilege is COLUMN-level on row_fingerprint ONLY (a SHA-256 the
--     writer already computes at insert time). The PHI ciphertext columns
--     (patient_name, member_id, group_number) remain UNREADABLE to the writer
--     (no column privilege) — verified via has_column_privilege.
--   - The policy is SELECT-only and row-level; it governs row visibility for the
--     arbiter, not column access. The table stays APPEND-ONLY: no role has UPDATE
--     or DELETE (no such grant or policy is added here).
--
-- Depends on: 0013 (cmd_rollup_writer role + USAGE on schema collections) and 0019
-- (collections.cmd_explorer_rows table, RLS, and the writer INSERT grant/policy).
--
-- Idempotent (docs/CLAUDE.md §2): role created only-if-absent (never DROP ROLE);
-- GRANT re-applies cleanly; DROP POLICY IF EXISTS before CREATE POLICY (avoids 42710).

-- 1. Role (privilege-only; reuse existing, created only-if-absent — mirrors 0013/0019).
do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'cmd_rollup_writer') then
    create role cmd_rollup_writer nologin;
  end if;
end$$;

-- 2. Column-level SELECT on the non-PHI conflict-arbiter column ONLY.
grant select (row_fingerprint) on collections.cmd_explorer_rows to cmd_rollup_writer;

-- 3. SELECT policy so the ON CONFLICT arbiter can run under RLS. Row-level visibility
--    only; PHI columns stay protected by the column ACL above.
drop policy if exists cmd_explorer_writer_select on collections.cmd_explorer_rows;
create policy cmd_explorer_writer_select on collections.cmd_explorer_rows
  for select to cmd_rollup_writer using (true);
