# SESSION 4 of 13 — Python ML Runtime (Sprint 2)

**Purpose:** stand up the $0-cost Python execution tier on GitHub Actions, structurally
tenant-parameterized, and run the full brain pipeline once for BXR Consulting.

```
=====================================================================
ROLE & DISCIPLINE

You are a senior software engineer embedded with Alec Lowi (Treat
Health AI). Read CLAUDE.md at the repo root IN FULL first; surface —
never silently resolve — conflicts between it, this prompt, and
observed reality. Trunk-based on main; show every artifact and HOLD
before any commit, push, workflow-dispatch against production data,
or deploy. Never add a Co-Authored-By trailer. PHI denylist absolute:
patient_last, patient_first, member_id, dob never enter features OR
embedding inputs — de-identification is a Brain 2/3 input contract,
not just a Brain 1 output contract. Secrets from env / repo secrets
only; never echoed into logs or chat.

STANDING DECISION: Veris is the multi-tenant product; CMD-Billing-
Dashboard stays untouched.

PREREQUISITES — VERIFY, DON'T ASSUME

- Session 3's handoff pasted above: brain1_features holds the FULL
  feature surface for BXR Consulting — expect 64,346 total / 57,486
  labeled (trainset = is_training_eligible AND label_is_terminal;
  PENDING rows are valid state, NEVER training rows). Confirm the
  count live now. Ingest-path role confirmed: claims_admin.
- BLOCKING PREREQUISITE: the ref.cms_pfs_rate corrections directive
  (CF-variant selection + non-payable-rate handling) is complete and
  verified. Do NOT train while the table carries order-dependent
  QP-conversion-factor rates or $0.00 H-code rows —
  feature_engineering.py LEFT JOINs avg(facility_rate) from
  ref.cms_pfs_rate straight into the training frame, so a contaminated
  fee anchor bakes silently into the baseline that Session 8's retrain
  is later judged against.
- The Python files exist per Session 1's topology report:
  feature_engineering.py, train.py (LightGBM + Cox PH + SHAP + DiCE),
  score_writer.py, embed_carc.py (BGE-M3), bocpd.py,
  claim_embedder.py. Confirm paths before wiring the workflow.

SCOPE

IN:  .github/workflows/brain_train.yml, HF weight caching, secrets
     wiring, one manual full pipeline run for BXR Consulting, PHI
     assertions at every model input.
OUT: Indigo in the matrix with real data (their staging is empty
     until Session 7 — include the matrix STRUCTURE now, gate the
     Indigo leg on the feature-flag state), any UI, any 835 work.

THE WORK

1. .github/workflows/brain_train.yml:
   - matrix strategy over business_entity_id (BXR Consulting uuid,
     Indigo uuid) so cross-tenant training is structurally
     impossible, not a documented manual step. Every Python
     invocation receives the tenant id and filters on it; a job
     without a tenant id fails, it does not default.
   - Each matrix leg first checks the per-tenant feature-flag /
     row-count threshold (Session 1 answer 4b) and exits cleanly if
     below threshold — LightGBM on near-zero rows is worse than no
     model. (The flag table lands in Session 6; until then, gate on
     a repo-variable allowlist and leave a TODO referencing S6.)
   - actions/cache on ~/.cache/huggingface/ — BGE-M3 is ~2.2GB;
     cache hit vs miss timing recorded.
   - Weekly schedule + workflow_dispatch. Concurrency group so two
     runs can't write scores simultaneously.

2. Secrets: DB connection for the pipeline as a repo secret. Decide
   the role explicitly — the pipeline reads staging.brain1_features
   and WRITES brain1_scores/brain2_alerts/claim_signatures, which
   claims_reader cannot do. Propose either the existing ingest role
   or a dedicated ml_writer role with INSERT/UPDATE on exactly the
   three output tables and SELECT on features/ref — present the
   grant list, HOLD, then create. Never the service-role key.

3. PHI assertions: confirm feature_engineering.py's denylist
   assertion runs, then add the SAME assertion at the point text is
   assembled for embed_carc.py and claim_embedder.py — embeddings
   leak PHI as easily as a raw column and it's a different code path
   than the one currently guarded. A fixture test feeds a
   deliberately-poisoned row and must fail closed.

4. One manual full run, BXR Consulting leg only:
   feature_engineering → train → score_writer → embed_carc → bocpd →
   claim_embedder. Show me the dispatch plan and HOLD before
   triggering. Capture: wall time per step, artifact sizes, rows
   written to brain1_scores (tenant-tagged), model metrics summary
   (AUC/PR, calibration note), SHAP top features.

5. Every embeddings write carries model_version (the BGE-M3 model
   identifier). Verify the column exists (Session 2) and is
   populated.

6. Append to veris-data-notes.md: run timings, cache behavior, model
   metrics baseline, the role decision, and any surprise.

DEFINITION OF DONE

- Green Actions run for the BXR Consulting leg; Indigo leg exits
  cleanly at the threshold check.
- brain1_scores has tenant-tagged rows for BXR Consulting ONLY —
  verified with a per-tenant count.
- PHI fixture tests fail closed at all three model-input points.
- HF cache proven (second run shows cache hit).
- Isolation test still passes.

HOLD GATES

HOLD before creating/altering any DB role or grants; HOLD before the
first workflow dispatch touches production data; HOLD before commit/
push of the workflow.

FIRST OUTPUT I WANT

The role/grant proposal (item 2) and the confirmed brain1_features
row count — before the workflow file is written.

END OF SESSION

Handoff for Session 5 (four sections, <500 words, my voice). Note in
Open threads: the model-metrics baseline (Session 8's retrain must
beat or explain it) and the S6 TODO on flag-gating the matrix.
=====================================================================
```
