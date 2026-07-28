# SESSION 3 of 13 — ETL + Reference Data (Sprint 1)

> **EXECUTED — 2026-07-06.** Historical spec. Where it conflicts with `docs/veris-data-notes.md` (S3 entries) or `docs/CLAUDE.md` §17/§18, **the notes / CLAUDE.md win.** Known supersessions: `0012_etl_backfill` landed as migration **020** (additive / upsert-only over the **full feature surface** — not the labeled-only INNER JOIN this file describes; PENDING rows are valid state); `days_to_pay` derives from **`payment_received_date − charge_from_date`** (empirically confirmed, 0 mismatches on 57,486 rows), NOT `primary_payment_date`; `brain1_features` = 64,346 total / 57,486 labeled for BXR Consulting; the "current 98" figure is the `ref.remittance_code` seed, not a RARC count (actuals after load: CARC 455 / RARC 1,192); "Treat Health" here means the **BXR Consulting** tenant.

**Purpose:** fill the reference tables, deploy the payer-drift matview, and populate
`staging.brain1_features` for Treat Health — the gate everything Python-side waits on.

```
=====================================================================
ROLE & DISCIPLINE

You are a senior software engineer embedded with Alec Lowi (Treat
Health AI). Read CLAUDE.md at the repo root IN FULL first; surface —
never silently resolve — any conflict between it, this prompt, and
observed reality. Trunk-based on main; show every diff/SQL artifact
and HOLD before any commit, migration, push, or deploy; one artifact
at a time; npm test + both typechecks before proposing a commit.
Never add a Co-Authored-By trailer. PHI denylist absolute
(patient_last, patient_first, member_id, dob — these NEVER enter
staging.brain1_features or any embedding input). Parameterized
queries, column allowlists, port 6543 no named prepared statements,
secrets from env only.

STANDING DECISION: Veris is the multi-tenant product;
CMD-Billing-Dashboard's schema/query library stays untouched.

PREREQUISITES — VERIFY, DON'T ASSUME

- Session 2's handoff pasted above. Tenancy columns + RLS + isolation
  test must be green — run the isolation test now and show the result
  before proceeding.
- The three Session-1 answers must be in docs/veris-data-notes.md:
  the claim_line↔payment_residual join key (verified live, not from
  the runbook), whether primary_payment_date exists, and the
  mv_payer_drift hardcoded-UUID check. If any is missing, run the
  SELECT now and record it — do not write ETL against an assumed key.

SCOPE

IN:  0008_mv_payer_drift deploy, ref-table loaders, 0012_etl_backfill
     + etl_backfill.ts, all tenant-tagged from the start.
OUT: Python execution (Session 4), 835 ingestion (Session 8), any
     Indigo data (Session 7 gates that).

THE WORK

1. Review 0008_mv_payer_drift.sql line by line: the drift thresholds
   in the params CTE, and confirm the Session-1 finding on hardcoded
   UUIDs. Present the review, HOLD, then deploy.

2. Run carc_rarc_refresh.ts (fills ref.carc_code / ref.rarc_code,
   backfills ref.remittance_code — expect ~250+ CARC, 1000+ RARC vs
   the current 98) and cms_pfs_loader.ts (ref.cms_pfs_rate, CY2026 BH
   HCPCS). Report before/after row counts per table. Defer
   nppes_loader.ts — it is a known no-op until a real NPI source
   exists; note that in veris-data-notes.md rather than running it.

3. Write 0012_etl_backfill.sql + etl_backfill.ts populating
   staging.brain1_features from staging.claim_line JOIN
   staging.payment_residual (on the VERIFIED join key) LEFT JOIN
   ref.payer_alias:
   - business_entity_id carried on every row from claim_line —
     tenant-tagged from day one, not a follow-up migration.
   - Batched INSERTs, run as the ingest-path role (claims_admin
     equivalent per the Veris DB's role layout — confirm the actual
     role name live first), with the tenant GUC set per transaction
     via the Session-2 helper.
   - The PHI denylist is enforced structurally: the column list of
     the INSERT...SELECT simply never includes the four fields, and a
     test asserts brain1_features' information_schema columns contain
     none of them.
   - turnaround_days derives from primary_payment_date -
     charge_from_date ONLY if Session 1 confirmed the column exists;
     otherwise leave the feature null and record the gap.
   - Before running, state the expected row count (count of the
     verified join for Treat Health's tenant id) and compare actuals
     after; a mismatch >1% stops the session for diagnosis.

4. If any embeddings table is touched incidentally, it gets a
   model_version column now.

5. Append to veris-data-notes.md: final ref-table counts, the ETL
   expected-vs-actual, and the exact join semantics used.

DEFINITION OF DONE

- 0008 deployed; matview refresh runs clean.
- ref tables at expected magnitudes (counts shown).
- brain1_features populated for Treat Health only, count matching
  expectation, zero PHI columns present (test proves it).
- Isolation test still passes post-ETL.
- Rollback script exists for 0012; both typechecks + tests clean.

HOLD GATES

HOLD before deploying 0008; HOLD before the backfill executes against
live data; HOLD before any commit/push.

FIRST OUTPUT I WANT

The verified join-key SELECT result, the expected brain1_features row
count for Treat Health, and the 0008 threshold review — before any
new file is written.

END OF SESSION

Handoff for Session 4 (four sections, <500 words, my voice). Open
threads: the confirmed role name used for the ingest path, and the
brain1_features row count Session 4's training run should expect.
=====================================================================
```
