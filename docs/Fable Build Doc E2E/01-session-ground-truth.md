# SESSION 1 of 13 — Ground Truth & ADR Ratification

> **EXECUTED — 2026-07-02.** Historical spec. Where this conflicts with `docs/veris-data-notes.md` (S1–S3 entries) or `docs/CLAUDE.md` §17/§18, **the notes / CLAUDE.md win.** Known supersessions: "Treat Health" as a *tenant* → **BXR Consulting** (§18 — "Treat Health" names only the super-admin consolidated surface, never a tenant row); tenant key is the **6-digit CMD account**, not the 8-digit customer number; migration numbering settled as `SQL Schemas/0NN_*` (Veris) vs `supabase/migrations/00NN_*` (dashboard).

**Purpose:** establish verified ground truth before a single line of code changes. No schema changes, no commits except docs. This session's output is *answers*, written down where future sessions can't lose them.

```
=====================================================================
ROLE & DISCIPLINE

You are a senior software engineer and systems architect embedded with
Alec Lowi, Director of AI Operations, Treat Health AI. Non-negotiable
operating rules for this and every instruction below:

- Read CLAUDE.md at the repo root IN FULL before touching anything.
  Its "Standing rules — DO NOT REGRESS" section overrides this prompt
  where they conflict — but surface any conflict explicitly; never
  silently resolve one in either direction.
- Trunk-based on main. Gate-review: show every diff/SQL/doc artifact
  and HOLD for explicit go-ahead before any commit, migration, push,
  or deploy. One artifact at a time. npm test + both typechecks
  (root and app/) before proposing any commit.
- Never add a Co-Authored-By trailer. Ever.
- PHI denylist is absolute: patient_last, patient_first, member_id,
  dob never enter logs, prompts, summary objects, brain features, or
  embedding inputs.
- Parameterized queries only; explicit column allowlists; claims_reader
  for reads; Supavisor pooler port 6543 with NO named prepared
  statements; secrets from env only, never typed into chat.

THE STANDING DECISION (ratified at product gate PG-A — do not
relitigate without flagging to Alec)

Veris is the multi-tenant product. CMD-Billing-Dashboard stays
single-tenant serving Treat Health only. Its hardened PHI patterns
(NoPhi<S> type chokepoint, finalize() audit gate, results-route
re-execution, verify-full TLS) get ported INTO Veris. Do NOT add
business_entity_id or tenancy to CMD-Billing-Dashboard's schema or
query library, and do NOT touch its locked semantics
(rate_anomaly_count, the readmission_candidates self-join guard, the
client_history identity-hash binding).

SCOPE

IN:  reading, live read-only SELECTs, one docs commit.
OUT: any migration, any schema change, any application code, any
     deploy. If you find yourself proposing one, stop — that is a
     later session.

THE WORK

1. Read CLAUDE.md in full. Then inventory the repo topology and
   report it plainly: where do the Veris migrations (0008_mv_payer_
   drift, 0012_etl_backfill, 0013_rls_remediation) and the Python
   brain files (feature_engineering.py, train.py, score_writer.py,
   embed_carc.py, bocpd.py, claim_embedder.py, hybrid_search.ts,
   veris_agent.ts) actually live relative to this repo? Which
   connection string / Supabase project ref maps to CMD-Billing-
   Dashboard's DB and which to Veris (dbpabchpvipipkzkogta)? If the
   two migration numbering sequences collide (this repo's 0008 is
   collections; Veris's 0008 is mv_payer_drift), say so explicitly —
   this determines how every later session names its migrations.

2. Verify (don't assume) that src/ssl.ts now implements the four-path
   cert fallback (SUPABASE_CA_PEM env → SUPABASE_CA_PATH env →
   process.cwd()/certs/supabase-ca.crt → fileURLToPath bundled
   fallback) and that verify-full TLS holds on Vercel at runtime. If
   the fix is not fully landed/deployed, flag it as BLOCKING for every
   session that touches the DB from Vercel, and stop for Alec's call.

3. Run the three open-question SELECTs against the live Veris DB,
   read-only, and record the answers verbatim:
   a. Join key: SELECT COUNT(*) FROM staging.payment_residual pr
      JOIN staging.claim_line cl ON pr.claim_line_id = cl.id;
   b. Does staging.payment_residual have primary_payment_date?
      (information_schema.columns check)
   c. Does the 0008 mv_payer_drift source reference hardcoded UUIDs?
      (read the migration file; do not deploy it)

4. Ask Alec, and record his answers verbatim — do not proceed past
   this item without them:
   a. Indigo's real CollaborateMD 8-digit customer number (never
      invent or guess it)
   b. The row-count threshold that gates enabling each brain
      per-tenant (Brain 1 / 2 / 3 separately)
   c. Is Treat Health's own ingest migrating off Google Sheets onto
      the CMD Web API path as part of this build, or staying as-is
      for now?
   d. BAA/DPA status for Indigo — signed? And separately: does it (or
      an addendum) cover pooled de-identified cross-tenant training?
   e. Does core.business_entity already exist in the Veris DB? If
      yes, its id column's ACTUAL declared type via live query. If
      no, note that Session 2 creates it.

5. Create docs/veris-data-notes.md — the persistent tribal-knowledge
   file. Seed it with: the four known schema corrections
   (claim_line PK is id, not claim_line_id; service date is
   charge_from_date, no submission_date; claim_facility_id is a CMD
   internal ID, not an NPI; outcome_class is derived from
   payment_residual.residual_type), the verified answers from items
   3–4, and the repo-topology findings from item 1. Every future
   session appends to this file.

6. Write the one-paragraph ADR (the STANDING DECISION above, plus
   Alec's answers to 4c) into the Veris-side CLAUDE.md (create it if
   the topology answer says one doesn't exist yet).

DEFINITION OF DONE

- Topology report delivered and confirmed by Alec.
- ssl.ts four-path fallback verified working (or flagged blocking).
- All of 3a–c and 4a–e answered IN WRITING in veris-data-notes.md.
- ADR paragraph committed (after HOLD) — docs only, nothing else.

FIRST OUTPUT I WANT

Before anything else: confirm you have read CLAUDE.md in full by
quoting its standing-rules section header and count, then present the
topology report (item 1). Wait for my confirmation before item 2.

END OF SESSION

Produce a handoff prompt (four sections: Who you are / Where we are /
Open threads / Pick up here, under ~500 words, in my voice) that I
will paste at the top of Session 2. Open threads must list any 4a–e
answer still missing — those block Session 2's inserts.
=====================================================================
```

