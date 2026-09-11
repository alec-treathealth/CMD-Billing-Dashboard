-- 0113 — claims.ar_claim.cmd_work_state: the SNAPSHOT-DERIVED work state.
--
-- WHY: the AR queue's five non-`open` work-status chips (In progress / Waiting on payer / Appeal /
--   Resolved / Dismissed) returned ZERO rows for every user, and could not have returned anything
--   else. They filter `coalesce(w.work_status, 'open')` against claims.ar_claim_work, which is
--   HUMAN-OWNED (0109 section 8: "owned by humans, never by the ingest") and held 0 rows against
--   59,070 claims on 2026-09-10 — so every claim read 'open', "Open" matched all of them and the
--   other five matched none. The ingest role cannot fix that by writing there: claims_audit_writer
--   holds NO privilege of any kind on ar_claim_work, by design.
--
--   CMD does carry the signal, and the snapshot already lands it — it was simply never read:
--   `cmd_status_text` (CMD's hand-applied status, 3,618 claims) is the billers' own work
--   vocabulary, and `ar_claim_status_event.err_fixed` marks whether a clearinghouse error is still
--   open. This column stores the state derived from those, so the chips are useful before anyone
--   has triaged a claim, WITHOUT the ingest ever writing a human disposition.
--
-- WHY A STORED COLUMN AND NOT A READ-TIME DERIVATION: measured on the live queue query,
--   2026-09-10 — baseline 53.9 ms; the same derivation as a read-time lateral 323 ms; as a
--   read-time FILTER 367 ms with a seq scan of ar_claim_status_event (58,084 rows discarded), and
--   that table grows every night. Derived at ingest it is free: arSnapshotMap already holds the
--   latest error per claim in memory when it builds the claim row.
--
-- THE VOCABULARY DELIBERATELY EXCLUDES 'appeal'. There is no appeal concept anywhere in the CMD
--   snapshot: 1 of 71,926 status messages contains the word, no table or column in the 30-table
--   extract models one, and 'APPEAL' does not appear in the hand-applied status vocabulary across
--   all 20 customers. Appeal stays human-only; ar_claim_work.work_status keeps its own 6-value
--   CHECK including 'appeal', and that asymmetry is the point. Widening this CHECK requires a new
--   migration and a source to justify it.
--
-- NULL means "not yet derived" — every row is NULL until the next snapshot run rewrites it, which
--   is why reads must coalesce. It is NOT backfilled here on purpose: the TypeScript mapper is the
--   single authority for this rule, and a SQL backfill would be a second implementation of it,
--   free to drift. `/api/cron/ar-snapshot` (14:05 UTC) fills every row on its next pass.
--
-- PHI DISCIPLINE: derived from money, dates, CMD status codes and a payer-boilerplate flag. No PHI
--   input, and the column is safe for the cached, PHI-free queue payload.
-- OWNERSHIP: claims_admin (claims plane) — `set role claims_admin`.
-- IDEMPOTENT: add column if not exists; index if not exists; grants re-asserted.
-- DEPENDENCY: 0109 (claims.ar_claim, claims.ar_claim_status_event).
-- NUMBER: 0113, not 0112 — 0112 is CLAIMED by an untracked 0112_app_user_facility.sql in the
--   CMD-BD-wt-userseat worktree (the 0096 collision lesson: a file listing is not the number, and
--   neither is this repo's committed tree alone).
-- Rollback: 0113_ar_claim_cmd_work_state_rollback.sql

set role claims_admin;

alter table claims.ar_claim
  add column if not exists cmd_work_state text;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'claims.ar_claim'::regclass and conname = 'ar_claim_cmd_work_state_check'
  ) then
    alter table claims.ar_claim
      add constraint ar_claim_cmd_work_state_check
      check (cmd_work_state is null or cmd_work_state in
        ('open', 'in_progress', 'waiting_payer', 'resolved', 'dismissed'));
  end if;
end $$;

comment on column claims.ar_claim.cmd_work_state is
  'Snapshot-DERIVED work state (arSnapshotMap.deriveCmdWorkState). NULL = not yet derived. Never a human disposition - that is claims.ar_claim_work.work_status, which alone may be appeal. Reads coalesce work_status FIRST, then this, and apply the overdue-follow-up rule at read time because this column is only as fresh as the last snapshot run.';

-- The chips filter on this column entity-scoped, the same shape as ar_claim_status_idx.
create index if not exists ar_claim_cmd_work_state_idx
  on claims.ar_claim (business_entity_id, cmd_work_state);

-- Grants re-asserted. `ar_claim`'s grants are TABLE-level (verified 2026-09-10: all 54 columns
-- listed for every grantee, which is what a table-level grant expands to), so they already cover a
-- new column. Restated so this migration is self-evidently complete rather than relying on the
-- reader knowing that.
grant select on claims.ar_claim to claims_reader;
grant select, insert, update on claims.ar_claim to claims_audit_writer;

reset role;

-- ═══ VERIFY AFTER APPLY — MANDATORY, AND NOT OPTIONAL BECAUSE IT LOOKS OBVIOUS ═══════════════
--
-- The paragraph above is a PRIVILEGE CLAIM, and this repo has already been burned by reasoning
-- about one instead of running it: 0106 asserted that `INSERT ... ON CONFLICT DO NOTHING` needs no
-- SELECT, which is false, and the plain revoke 42501'd the sync immediately. 0105 records the other
-- half — a grant is only half the gate, because RLS is a SECOND gate that fails by matching ZERO
-- ROWS rather than by raising (0089/0090/0101/0102 are four migrations in that one chain).
-- `claims_audit_writer` is NOT rolbypassrls and `claims.ar_claim` carries 4 policies, so both gates
-- are live here.
--
-- ⚠ THIS CANNOT BE CHECKED FROM AN MCP / `postgres` SESSION, AND `has_table_privilege` IS NOT THE
-- CHECK. Measured 2026-09-10: `pg_has_role('postgres','claims_audit_writer','SET')` is **false** —
-- postgres cannot assume the writer role at all (the same wall CLAUDE.md records for
-- claims_reader). And postgres IS rolbypassrls, so any row it writes proves nothing about RLS.
--
-- The only instrument that answers "can the writer actually store this column" is the real ingest
-- running as the real role. After applying, run ONE customer through it and confirm the column
-- lands — the 0105 pattern, where the proof was the writer inserting 11,161 rows itself:
--
--     npm run ingest:ar-snapshot -- --customer 10035974 --commit
--
--     select count(*) as claims, count(cmd_work_state) as with_state
--       from claims.ar_claim where cmd_customer_id = '10035974';
--
-- TREAT_CO is the deliberate choice: it is the smallest book on the roster (7 claims, measured
-- 2026-09-10) so the run is seconds, AND those 7 rows ALREADY EXIST — which is the point. On
-- pre-existing rows the upsert takes its ON CONFLICT **DO UPDATE** arm, so a pass proves the
-- writer can UPDATE the new column under its grants and row policies. A fresh-insert-only check
-- would exercise the easier arm and miss exactly the privilege this migration adds.
--
-- PASS = `with_state` equals `claims` (7 of 7). A 42501 is the loud failure; `with_state` = 0 with
-- no error is the QUIET one — that is RLS matching zero rows, the 0101 shape — and either must be
-- caught here, before 14:05 UTC takes all 19 accounts through the same statement.
--
-- ⚠ Do NOT substitute a `--customer` id that is not on AR_SNAPSHOT_CUSTOMERS: the CLI filters the
-- roster by that flag, so a wrong id prints `customers=0` and exits 0. The check would pass while
-- verifying nothing.
