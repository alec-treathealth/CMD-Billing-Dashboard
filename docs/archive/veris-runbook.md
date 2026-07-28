# Veris three-brain build — runbook & status

Companion to CLAUDE.md §17. Tracks the public-data + three-brain ML build that
runs ALONGSIDE the existing `staging.*` pipeline. Project `dbpabchpvipipkzkogta`.

## Status (2026-06-23)

### DEPLOYED + VERIFIED (against the live DB)
The entire SQL backbone is applied via `apply_migration` and confirmed present:

| Migration | Objects | State |
|-----------|---------|-------|
| `009_public_ref_tables.sql` | `ref.carc_code`, `ref.rarc_code`, `ref.cms_pfs_rate`, `ref.nppes_provider` + HNSW/FTS indexes + `hnsw.iterative_scan='relaxed_order'` | deployed, empty |
| `010_brain1_scores.sql` | `staging.brain1_scores` (RLS) | deployed, empty |
| `011_brain2_carc_vectors.sql` | `ref.carc_embeddings`, `ref.rarc_embeddings`, `staging.brain2_alerts` (RLS) | deployed, empty |
| `012_brain3_claim_vectors.sql` | `staging.claim_signatures`, `staging.appeal_evidence` (RLS) | deployed, empty |

Environment confirmed: pgvector **0.8.0** (`halfvec`, HNSW, iterative scan all OK),
`pgcrypto`/`gen_random_uuid()`, `pg_cron`, `pgmq` present. Postgres 17.6.

### NOT executed here (needs a runtime this web session lacks)
The data loaders (TypeScript) and all ML (Python) are delivered as **reviewed,
runnable code** — they are NOT run, because this environment has no Python/Node
execution against the heavy ML stack (LightGBM/SHAP/DiCE/Cox, BGE-M3 + torch),
no GPU, and outbound calls to x12.org / CMS / NPPES are gated by the network
policy. Run them where those exist (see Run order).

## Corrections to the build spec (grounded in the real schema/data)

These differ from the prompt's CONTEXT block, which was partly stale:

1. **`staging.claim_line` is 150,900 rows**, not 151,059 — the `007` null-credit
   dedup already landed. `mv_payer_drift` did **not** exist at start (008 had
   never been deployed); unrelated to this build.
2. **Real column names** (the spec used names that don't exist): claim_line PK is
   `id` (not `claim_line_id`); procedure code is `cpt_code` (not `primary_cpt_code`);
   service date is `charge_from_date` (not `service_from_date`); type-of-bill is
   `tob_raw` + decomposed `tob_*` (not `tob_code`); there is no `submission_date`;
   `payment_residual` has `primary_paid`/`secondary_paid` (no `actual_payment_amount`).
   All migrations + code use the real names.
3. **`claim_facility_id` is a CMD internal id (8-digit, e.g. `10272308`), NOT an
   NPI.** The spec's NPPES loader assumed facility ids = NPIs — false. There is no
   facility→NPI crosswalk in the data. `nppes_loader.ts` therefore targets any
   10-digit NPI found in `claim_rendering_provider`/`charge_rendering_provider`
   and is a **no-op until a real NPI source is wired in** — flagged, not silently shipped.
4. **`outcome_class`**: `brain1_features.outcome` is text (`PAID/DENIED/PARTIAL/
   PENDING`). Brain 3 stores an int `outcome_class` (0 CLEAN / 1 PARTIAL/ALLOWED_GAP
   / 2 BALANCE_DUE_INSURANCE / 3 MATH_GAP) derived from `payment_residual.residual_type`.

## SECURITY — action for the owner (not auto-applied)

`get_advisors`/`list_tables` flagged **RLS disabled** on 6 tables:
`ref.payer_alias` and the VOB tables `ref.payers`, `ref.plans`, `ref.service_codes`,
`ref.diagnosis_codes`, `ref.denial_codes`. `ref.payer_alias` is a global non-PHI
reference table (like `ref.remittance_code`, which DOES enable RLS with a
`USING(true)` read-all policy) — low risk but inconsistent. To make it consistent:

```sql
ALTER TABLE ref.payer_alias ENABLE ROW LEVEL SECURITY;
CREATE POLICY payer_alias_read_all ON ref.payer_alias FOR SELECT USING (true);
```

The 5 VOB `ref.*` tables are empty and belong to the other pipeline — decide
separately. Not applied here by design (enabling RLS without a policy blocks reads).

## Run order (where a runtime exists)

```
# Phase 0 — public reference data
npx tsx src/public_data/carc_rarc_refresh.ts     # fills ref.carc_code / ref.rarc_code + backfills ref.remittance_code
npx tsx src/public_data/cms_pfs_loader.ts         # fills ref.cms_pfs_rate (CY2026 BH HCPCS)
npx tsx src/public_data/nppes_loader.ts           # BLOCKED: needs a real NPI source (see correction #3)

# Phase 1 — Brain 1 (LightGBM predictor)
pip install -r requirements-brain1.txt --break-system-packages
python src/brain1/feature_engineering.py          # time-based split, leakage firewall
python src/brain1/train.py                         # multiclass + regressor + Cox + SHAP + DiCE
python src/brain1/score_writer.py                  # -> staging.brain1_scores

# Phase 2 — Brain 2 (drift)
pip install -r requirements-brain2.txt --break-system-packages
python src/brain2/embed_carc.py                    # BGE-M3 -> ref.carc_embeddings / ref.rarc_embeddings
python src/brain2/bocpd.py                          # ADWIN pre-filter -> BOCPD -> staging.brain2_alerts

# Phase 3 — Brain 3 (evidence)
pip install -r requirements-brain3.txt --break-system-packages
python src/brain3/claim_embedder.py                # BGE-M3 -> staging.claim_signatures
npx tsx -e "import {retrieveAppealEvidence} from './src/brain3/hybrid_search'"  # RRF fusion

# Phase 4 — Claude reasoning layer
npx tsx src/agent/veris_agent.ts <charge_debit_id>
```

DB access for loaders/scripts: `claims_admin` connection (writer) on pooler port
**6543** — parameterized statements only, **no named prepared statements**.
Set the tenant GUC per-transaction: `set_config('app.business_entity_id', $beid, true)`.
