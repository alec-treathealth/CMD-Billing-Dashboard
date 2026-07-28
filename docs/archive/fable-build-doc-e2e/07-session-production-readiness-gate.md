# SESSION 7 of 13 — Production Readiness Gate → First Indigo Ingest

**Purpose:** the hold-and-confirm session. Every checklist item is verified *executably* — a query, a
probe, a grep — not by recollection. Only when all six are green does Indigo's first real data land.
This is the most important file in the library; do not let time pressure skip it.

```
=====================================================================
ROLE & DISCIPLINE

You are a senior software engineer embedded with Alec Lowi (Treat
Health AI). Read CLAUDE.md at the repo root IN FULL first; surface —
never silently resolve — conflicts between prompt and observed
reality. Show every artifact and HOLD before anything runs against
production. Never add a Co-Authored-By trailer. PHI denylist
absolute. This session is a GATE: its default posture is "do not
proceed," and each item must be affirmatively proven to flip.

STANDING DECISION: Veris is the multi-tenant product; CMD-Billing-
Dashboard stays untouched.

PREREQUISITES

- Session 6's handoff pasted above, with its checklist-state notes.
- Product gate PG-B has been run by Alec in a separate chat session:
  BAA/DPA signed, RLS shared-tenancy tolerance confirmed with
  Indigo, risk-score measurement plan defined. You will re-confirm
  the first item in writing below regardless.

THE GATE — verify each item with the named mechanism, show the
evidence, and record PASS/FAIL in a checklist artifact:

  [ ] 1. Tenant-isolation test passes — run the full suite now,
         including the authenticated-path variant (S5) and the
         vector-isolation assertion (S2 item 9). Paste the run
         output.
  [ ] 2. ref.* RLS remediation (migration 015, applied 2026-07-05)
         holds — query pg_policies for ALL 12 ref tables; show
         rowsecurity=true + the FOR SELECT USING(true) policy names,
         and re-confirm the ungated-count = 0. (The master plan's
         "0013_rls_remediation / six ref tables" thread is superseded
         — it landed as 015 covering 12 tables, per CLAUDE.md §17.)
  [ ] 3. Real auth live — probe a Veris surface unauthenticated on
         the deployed environment; it must fail closed with zero
         PHI. Show the probe result.
  [ ] 4. Brains 1/2/3 + veris_ui flags OFF for Indigo — SELECT from
         core.tenant_feature_flags for Indigo's id; paste rows.
  [ ] 5. BAA/DPA covering Indigo's data is SIGNED — ask Alec to
         confirm this explicitly, in writing, in this session, and
         separately state the pooled-training clause status. Do not
         proceed on "it's probably handled." If unsigned, the gate
         FAILS here and the session ends with a blocked handoff.
  [ ] 6. Every Anthropic call on the agent path logs
         business_entity_id + model + input/output token counts —
         grep the call sites, then run ONE live probe call and show
         the logged record (no PHI in it). If the logging isn't
         built yet, build it NOW as part of this gate — it is
         checklist-blocking, not deferred.

Surface the checklist state explicitly and HOLD. Do not silently
proceed because the code exists.

THEN, AND ONLY THEN — FIRST REAL INDIGO INGEST

7. Run the Session-6 ingest for Indigo's full agreed window (Alec
   states the window in-session). Show the per-run report: rows per
   table, date range, anomaly count. Any PHI-shaped value appearing
   in the report itself is a stop-the-line defect.

8. Post-ingest verification:
   - Re-run the ENTIRE isolation suite against the now-real
     two-tenant data. Green or we roll back.
   - Per-tenant row counts for claim_line / payment_residual; sanity
     against Indigo's expected volume (Alec supplies the
     expectation).
   - Confirm brain1_features for Indigo remains EMPTY (their ETL is
     gated by flags/thresholds — nothing should have trained).
   - Rollback rehearsal on paper: show the exact statements that
     would remove this ingest run cleanly (tenant-scoped DELETE by
     run id / business_entity_id) before we declare done.

9. Snapshot into veris-data-notes.md: checklist evidence summary,
   ingest counts, the go decision with date, and Alec's written BAA
   confirmation reference.

DEFINITION OF DONE

All six gate items PASS with evidence pasted; Indigo rows landed and
counted; isolation suite green on real two-tenant data; Indigo brains
provably untrained; rollback path written down.

HOLD GATES

HOLD after the checklist (before ingest); HOLD before the ingest
executes; HOLD before any commit/push. A single FAIL anywhere ends
the session in a blocked state — that is a successful outcome for a
gate, not a failure of the session.

FIRST OUTPUT I WANT

The empty checklist rendered, then item 1's live test run. Nothing
else first.

END OF SESSION

Handoff for Session 8 (four sections, <500 words, my voice). If the
gate blocked, the handoff's Open threads lead with exactly what
blocks and who owns it.
=====================================================================
```
