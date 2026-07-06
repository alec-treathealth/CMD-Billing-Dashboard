# SESSION 2 of 13 — Tenancy Foundation & Isolation Test

> **EXECUTED — 2026-07-02→06.** Historical spec. Where it conflicts with `docs/veris-data-notes.md` or `docs/CLAUDE.md` §17/§18, **the notes / CLAUDE.md win.** Known supersessions: the six-ungated-ref-tables / `0013_rls_remediation` thread landed as migration **015** (12 ref tables RLS-gated, ungated-count = 0) — not `0013`; `core.business_entity` was seeded with the **canonical UUIDs from `src/tenants.ts`** (never `gen_random_uuid()`); "Insert rows for Treat Health and Indigo" → **BXR Consulting + Indigo** (§18 hard guard: no Treat Health tenant row, ever); "171 tests" is a stale literal — the hermetic suite has since grown.

**Purpose:** Sprint 0's safety net. `core.business_entity`, RLS remediation, tenancy columns +
policies on every Veris table, and — before any ingest path exists — the tenant-isolation test.

```
=====================================================================
ROLE & DISCIPLINE

You are a senior software engineer embedded with Alec Lowi (Treat
Health AI). Read CLAUDE.md at the repo root IN FULL before touching
anything; surface (never silently resolve) any conflict between it,
this prompt, and observed reality. Trunk-based on main; show every
diff/SQL artifact and HOLD before any commit, migration, push, or
deploy; one artifact at a time; npm test + both typechecks before
proposing a commit. Never add a Co-Authored-By trailer. PHI denylist
absolute (patient_last, patient_first, member_id, dob). Parameterized
queries, column allowlists, claims_reader for reads, port 6543 no
named prepared statements, secrets from env only.

STANDING DECISION: Veris is the multi-tenant product;
CMD-Billing-Dashboard stays single-tenant and its schema, query
library, and locked semantics are NOT touched in this session.

PREREQUISITES — VERIFY, DON'T ASSUME

- Session 1's handoff is pasted above this prompt. It must contain:
  Indigo's cmd_customer_number, the core.business_entity existence/
  type answer, and the repo-topology decision on migration numbering.
  If any is missing, stop and ask.
- Confirm docs/veris-data-notes.md exists; you will append to it.

SCOPE

IN:  core.business_entity, deploying 0013_rls_remediation, tenancy
     columns + RLS + composite indexes on Veris tables, GUC plumbing
     helper, tenant-isolation test, rollback scripts.
OUT: any ingest code, any auth, any UI, anything in CMD-Billing-
     Dashboard's claims/collections schemas.

THE WORK

1. core.business_entity: create if absent (id uuid pk default
   gen_random_uuid(), name text not null, cmd_customer_number text,
   status text not null default 'active', created_at timestamptz not
   null default now()). Insert rows for Treat Health and Indigo
   (Indigo's real customer number from Session 1). Idempotent.

2. Review, then deploy 0013_rls_remediation.sql — the six ungated
   ref tables (payer_alias, payers, plans, service_codes,
   diagnosis_codes, denial_codes). Do this BEFORE adding tenancy on
   top; never stack tenancy onto tables with RLS still disabled.

3. Add business_entity_id uuid NOT NULL REFERENCES
   core.business_entity(id) ON DELETE RESTRICT to every tenant-scoped
   Veris table: staging.claim_line, staging.payment_residual,
   staging.brain1_features, staging.brain1_scores,
   staging.brain2_alerts, staging.claim_signatures,
   staging.appeal_evidence, plus the six ref.* tables where tenancy
   applies. Before EACH alter: confirm core.business_entity.id's
   declared type with a live query — a silent uuid/text mismatch
   makes an RLS policy no-op. For pre-existing rows, backfill with
   Treat Health's id in the same migration, then set NOT NULL.

4. RLS on each table:
     USING (business_entity_id =
            current_setting('app.business_entity_id')::uuid)
     WITH CHECK (same)
   DROP POLICY IF EXISTS before CREATE POLICY. Idempotent forward.

5. Composite indexes leading with the tenant column on every hot
   path — (business_entity_id, payer_name), (business_entity_id,
   cpt_code), (business_entity_id, charge_from_date) — a bare
   business_entity_id index alone is not acceptable. Propose the
   exact list per table before writing it.

6. Write a rollback script alongside EVERY forward migration in this
   session, in addition to idempotent-forward discipline.

7. GUC plumbing: a server-side helper (ported from the composition-
   root pattern in app/lib/server.ts) that runs
   SET LOCAL app.business_entity_id = $1 at the top of each
   transaction. The tenant id is never accepted from any
   client-supplied field.

8. The tenant-isolation test (this must exist and pass BEFORE any
   ingest path is built in Session 6): seed two synthetic
   business_entity rows with distinct fake claim_line/
   payment_residual data; assert a session scoped to tenant A via the
   GUC returns ZERO tenant-B rows across every query surface touched.
   Hermetic where possible per CLAUDE.md test rules; a separate
   manually-run live variant is acceptable for the RLS layer itself —
   propose the split before writing.

9. Vector-isolation assertion, distinct from item 8: if
   staging.claim_signatures / hybrid_search.ts is reachable, assert
   the business_entity_id filter is applied BEFORE the HNSW/ANN step
   (pgvector iterative scan), never as a post-filter — an unfiltered
   ANN search retrieving tenant B's claims as "similar evidence" is
   its own bug class. Add a model_version column to any embeddings
   table you touch, even though nothing consumes it yet.

DEFINITION OF DONE

- 0013 deployed; pg_policies query output shown for all six tables.
- Every listed table carries the FK (RESTRICT), RLS, and a leading-
  tenant composite index; column type verified live per table.
- Rollback script exists per migration.
- Isolation test (8) and vector assertion (9) exist and pass.
- Existing 171 tests still pass; both typechecks clean.
- veris-data-notes.md updated with any surprises.

HOLD GATES

HOLD before deploying 0013; HOLD before each tenancy migration runs
live; HOLD before any commit/push.

FIRST OUTPUT I WANT

The table-by-table plan (columns/indexes/policies per table) and the
verified core.business_entity.id type — before any SQL is written.

END OF SESSION

Handoff prompt (Who you are / Where we are / Open threads / Pick up
here, <500 words, my voice) for Session 3. Open threads must note
whether mv_payer_drift's UUID question (Session 1, 3c) cleared.
=====================================================================
```
