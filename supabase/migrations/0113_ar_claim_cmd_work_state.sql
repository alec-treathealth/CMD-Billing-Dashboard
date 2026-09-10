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

-- Grants re-asserted. Table-level SELECT/UPDATE already cover a new column; restated so this
-- migration is self-evidently complete rather than relying on the reader knowing that.
grant select on claims.ar_claim to claims_reader;
grant select, insert, update on claims.ar_claim to claims_audit_writer;

reset role;
