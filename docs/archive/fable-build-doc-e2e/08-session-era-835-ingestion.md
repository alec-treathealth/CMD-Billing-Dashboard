# SESSION 8 of 13 — 835/ERA Ingestion + Clean-Label Retrain (Sprint 3)

**Purpose:** the hard prerequisite that gates half the product. CAS-level 835 data separates
contractual write-offs from real underpayments. Brain 2 ALREADY runs today on manual-EOB CARC in
`staging.era_adjustment` (65,615 BXR rows; `mv_payer_drift` live) — 835 is the label-QUALITY
upgrade: a CAS-level, distinguishable-provenance feed that lets Brain 1 retrain on real (not
synthetic) miss labels. Built tenant-aware from line one.

```
=====================================================================
ROLE & DISCIPLINE

You are a senior software engineer embedded with Alec Lowi (Treat
Health AI). Read CLAUDE.md at the repo root IN FULL first; surface —
never silently resolve — conflicts between prompt and observed
reality. Trunk-based on main; show every artifact and HOLD before
any commit, migration, push, deploy, or live scheduled job. Never
add a Co-Authored-By trailer. PHI denylist absolute — and note: 835
files carry patient identifiers; the parser may see them in flight,
but NONE of the four denylist fields land in era_adjustment,
features, embeddings, logs, or run reports. Parameterized queries,
port 6543, per-tenant credentials from env only.

STANDING DECISION: Veris is the multi-tenant product; CMD-Billing-
Dashboard stays untouched.

PREREQUISITES — VERIFY, DON'T ASSUME

- Session 7 gate passed; two tenants have real claim data (confirm
  per-tenant counts live).
- Session 4's pipeline runs green for BXR Consulting; its model-metrics
  baseline is in veris-data-notes.md (the retrain must beat or
  explain it).
- The era-835 foundation is ALREADY BUILT and committed (UNAPPLIED —
  commit `013…` on main): migration 013_era_835_adjustment lands a
  SEPARATE table at the native 835 CAS grain — NOT staging.era_adjustment,
  whose CMD charge/credit grain cannot hold an 835 — plus
  src/ingest/era835Parser.ts + era_ingest.ts + hermetic tests (green).
  This session APPLIES 013, wires the live CMD 835 download
  (src/collections/cmd835.ts — its endpoint contract is UNVERIFIED,
  probe structure first), schedules, and retrains. Do NOT rebuild the
  parser; confirm 013's deployed shape live before/after applying.

SCOPE

IN:  src/ingest/era_ingest.ts, X12 CAS parsing, pg_cron schedule,
     Brain 1 retrain on CO/PR/OA-derived labels, BOCPD alert-rate
     baseline. Stedi wiring IF Alec confirms credentials are ready.
OUT: any alerting UI (the plan explicitly defers it until the true
     alert rate is known — §3.3 assumption 2), appeal generation,
     Kipu/LCD sources.

THE WORK

1. FIRST OUTPUT decision — source of 835s, per tenant: CMD's
   /payment/download-835 path, Stedi, or both behind one interface.
   Present the tradeoff (CMD availability per tenant vs Stedi's
   CAS quality at ~$0.01/txn), ask which is live-ready TODAY, and
   build the confirmed one; the other gets the same interface
   stubbed. HOLD on this before code.

2. era_ingest.ts (already built — verify, don't rewrite): per-tenant
   credentials (same CMD_CREDENTIALS_{TENANT} pattern / Stedi key),
   fetch → parse → upsert into staging.era_835_adjustment (013's
   native-835-grain table, NOT era_adjustment) tenant-tagged,
   idempotent on the 835's natural keys (row_fingerprint over the CAS
   triplet + claim/line context — verify against the spec and record
   in veris-data-notes.md).

3. CAS parser per X12 835 5010: loop 2100 (claim) / 2110 (line);
   CAS*<group>*<reason>*<amount>[*qty] with repeating triplets;
   group codes CO/PR/OA/PI/CR. Hermetic unit tests from constructed
   fixture segments — happy path, multi-triplet, malformed segment
   fails closed, and a fixture containing patient-name segments
   proving they never reach the persisted row or any log line.

4. Schedule: pg_cron daily per tenant (or a single job iterating
   active tenants — propose which, considering failure isolation).
   HOLD before the schedule goes live.

5. Once staging.era_835_adjustment has real 835-sourced rows for at least one tenant:
   - Derive the clean outcome label (CO=contractual, PR=patient
     responsibility, real-miss residue) and re-run the Session-4
     pipeline for that tenant. Compare against the baseline: AUC/PR,
     calibration, SHAP shifts. Present the comparison — if the
     "clean" labels make metrics WORSE, stop and diagnose rather
     than shipping the retrain.
   - Run bocpd.py against the live (payer, carc, week) series and
     record the RAW ALERT RATE over the available history. This
     number decides whether drift alerts are actionable at their
     natural frequency — write it in veris-data-notes.md; build no
     UI against it in this session.

DEFINITION OF DONE

- era_835_adjustment populated for ≥1 tenant, tenant-tagged, RLS-covered
  (isolation suite re-run, green).
- Parser tests green and hermetic; malformed-input fails closed.
- Cron live (or held with reason); run report format has zero PHI.
- Retrain comparison presented and dispositioned; BOCPD alert-rate
  baseline recorded.

HOLD GATES

HOLD on the source decision; HOLD before first live 835 fetch per
tenant; HOLD before cron activation; HOLD before the retrained model
replaces the serving scores; HOLD before commit/push.

FIRST OUTPUT I WANT

The source-per-tenant decision matrix and era_adjustment's verified
live shape — before any code.

END OF SESSION

Handoff for Session 9 (four sections, <500 words, my voice). Open
threads: retrain disposition, alert-rate number, and whichever 835
source remains stubbed.
=====================================================================
```
