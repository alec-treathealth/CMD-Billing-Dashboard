# VOB → Supabase load & enrichment — PLAN

_Date: 2026-07-22. Target project: `dbpabchpvipipkzkogta` (cmd-billing-dashboard cluster). Goal: match the Monday-PDF VOB benefits into the **BXR + Indigo collections** data so the **Collections** and **Qualify** tabs can show each member's verified benefits. Plan only — no code/DDL yet._

## 1. What the recon established (grounding facts)

- Source data: **33,060 curated admitted VOB rows** (local CSV, `/Users/aleclowi/vob-data/indigo_vob_curated.csv`), keyed by `member_id` from the PDFs. ~4% have no member_id.
- Collections model in the target DB:
  - `collections.cmd_explorer_rows` — the **Collections tab** feed. 634,788 rows (Indigo 491,380 / BXR 143,408), **10,692 distinct members**.
  - `collections.cmd_charge_census` — the **Qualify tab** feed. 42,713 rows (Indigo 29,662 / BXR 13,051), **1,693 distinct members**.
  - **100% of rows in both carry `member_id_bidx`** → the entire collections side is matchable by member.
- **Match key = `member_id_bidx`** (keyed-HMAC blind index over normalized member_id). Fallbacks: `member_id_prefix_bidx` (alpha prefix), `group_number_bidx`.
- **The blind-index key is GLOBAL across tenants** — proven: 227 `member_id_bidx` values appear under *both* Indigo and BXR. So an Indigo-sourced VOB's bidx matches BXR collections rows too. Cross-tenant enrichment works with a single derivation.
- PHI in collections is **app-layer encrypted** (`member_id`/`patient_name`/`group_number` as `bytea`) **plus blind-index** (`*_bidx` text). No reusable SQL crypto function exists (only `vault._crypto_aead_det_*`) → **encryption + bidx derivation are done app-side** (TypeScript, `INDEX_HMAC_KEY`).
- Entities: **Indigo Consulting** `141d459c-f371-4229-9a92-ace198e940bb`, **BXR Consulting** `af504ab6-3dcd-4aa4-a93c-27bc58de4088`.
- The existing `vob` schema (`benefit_checks`, `benefit_check_services`, `claim_line_features`) is a **separate, unpopulated EDI/eligibility scaffold** keyed by `patient_hash` with integer payer/plan dimensions — not a fit for flat Monday-PDF rows. Keep the Monday VOB separate; treat that scaffold as a possible future normalization target only.

## 2. Match model

VOB data is **member/patient-level**, not charge-level (a VOB has no charge/claim id — just member identity + benefits). So one "current benefits" record per member enriches all that member's collections/census rows.

- **Primary match:** exact `member_id_bidx` (normalized subscriber id). Highest precision.
- **Fallbacks (v2):** `member_id_prefix_bidx` + `group_number_bidx` when exact id differs (subscriber vs patient, formatting).
- **No name/DOB fuzzy match against collections** — those are encrypted (`bytea`) with no name blind-index on the collections tables, so name matching would require decryption. Member-id match is the robust path.
- Match is **tenant-agnostic** (global bidx) → an Indigo VOB enriches both BXR and Indigo rows for that member; each collections row keeps its own `business_entity_id`.

**Enrichment ceiling:** at most the 10,692 distinct collections members (1,693 for qualify). Actual yield = intersection with VOB members, which we can only measure after computing bidx (that's the load itself). Reported as match-rate QA post-load.

## 3. Schema (new, kept separate from the existing `vob` scaffold)

**`vob.indigo_vob`** — raw, one row per Monday item:
- `monday_item_id` text PK
- `source_entity_id` uuid — provenance (Indigo board); **not** the match scope
- `facility` text (status60 label)
- **match keys** (computed at load): `member_id_bidx`, `member_id_prefix_bidx`, `group_number_bidx` (text)
- **benefits** (from PDF; store as text to preserve extracted fidelity — optional parsed numeric variants later): `policy_type`, `funding`, `insurance_co`, `payer_id`, `plan_type`, `ind_deductible`, `ind_deductible_met`, `family_deductible`, `family_deductible_met`, `ind_oop_max`, `ind_oop_met`, `family_oop_max`, `family_oop_met`, `coinsurance_combined`, `coinsurance_ip`, `coinsurance_op`, `coinsurance_after_oop`, `vob_datetime`
- **provenance:** `schema_version`, `extraction_flag`, `vob_created_at`, `monday_updated_at`, `loaded_at`
- **No raw identifiers persisted** (no name/DOB/member_id/notes) → minimal PHI; bidx is pseudonymous. **RLS on.**
  - _Option:_ if the UI must display a VOB-sourced name/DOB, add encrypted columns following the collections pattern. Recommend **not** initially — collections rows already carry the patient identity for display.

**`vob.member_benefits_current`** — matview/view: **latest VOB per `member_id_bidx`** (max `vob_datetime`, tie-break `monday_updated_at`/`monday_item_id`). This is what the tabs join to (dedupes repeat VOBs).

Indexes: btree on `member_id_bidx` (and prefix/group) in `member_benefits_current`; the collections `*_bidx` columns are already indexed for lookups.

## 4. Enrichment seam (how Collections & Qualify consume it)

- **Collections tab:** `cmd_explorer_rows` LEFT JOIN `vob.member_benefits_current` USING (`member_id_bidx`) → per-charge benefits + `has_vob` flag.
- **Qualify tab:** `cmd_charge_census` LEFT JOIN `vob.member_benefits_current` USING (`member_id_bidx`) → benefit context on leads/scoring.
- Delivered as **read views** (e.g. `collections.explorer_vob_enriched`, `collections.census_vob_enriched`) or as joins in the app's existing queries — app-team's call. **UI wiring is downstream of this data plan.**

## 5. Blind-index derivation — THE LINCHPIN

The loader must reproduce the app's **exact** `member_id` normalization + HMAC (`INDEX_HMAC_KEY`) to produce bidx values that equal the collections ones. Because bidx is computed locally in the loader, only pseudonymous data reaches the DB (the app's AES key is never needed here).

**GO/NO-GO validation before any bulk load:** compute bidx for a few member_ids known to exist in collections and confirm the hashes equal existing `member_id_bidx` values. If normalization differs (case, spaces, alpha-prefix handling), the match rate silently collapses. This gate must pass first.

## 6. Initial load

1. **DDL** via a migration (schema only, no PHI).
2. **Data** via a **local Python loader** (not MCP): read curated CSV → compute bidx locally → upsert **bidx + benefits** into `vob.indigo_vob` over a direct Postgres connection (psycopg, batched, parameterized). Raw member_id is used only to hash; never persisted, never logged.
3. Refresh `member_benefits_current`.
4. Rows with no member_id (~4%) and the flagged/NO_PDF_EXTRACT rows load with flags; unmatchable ones are expected.

## 7. Monday cron (ongoing sync)

- **Home:** GitHub Actions scheduled workflow in `VOB-scripts` (self-contained Python; secrets in GHA). _Alt: a Vercel Python function._
- **Cadence:** daily (configurable).
- **Prerequisite:** a **headless Monday API token** with read access to board `1606316049` + `files4` assets. (This session's OAuth path won't run headless, and the sandbox raw token cannot see this board.)
- **Each run:**
  1. Paginate board metadata (id, name, `status60`, `updated_at`) — chunked (~4×20 pages), non-PHI.
  2. Admitted set = Facility non-empty.
  3. Diff vs `vob.indigo_vob`:
     - new admitted → download PDF (signed URL, 1 h) → extract (`extract_vob` logic) → compute bidx → insert;
     - `updated_at` advanced → re-fetch + re-extract + update;
     - Facility cleared / item deleted → deactivate/delete row.
  4. Persist a watermark (max `updated_at`) in a `vob` sync-state row.
  5. Refresh `member_benefits_current`.
- **Resilience/PHI:** download promptly (URL expiry), retry on Monday rate limits, carry UNKNOWN/non-fillable flags (don't fail the run), delete ephemeral PDFs after extraction, no PHI in logs/artifacts.

## 8. Post-load QA (coverage only, no PHI)

- Match rate: of 10,692 collections members, how many matched a VOB — count + % per tenant; confirm the 227 cross-tenant members enrich both.
- Benefit-field coverage on matched rows.
- Reconcile loaded rows vs board admitted count.

## 9. Decisions / prerequisites needed from you

1. **`INDEX_HMAC_KEY` + normalization spec** (the linchpin) — provide or point to the app's blind-index derivation.
2. **Headless Monday token** for board `1606316049` (cron prerequisite).
3. **Cron home:** GitHub Actions (recommended) vs Vercel Python vs other.
4. **PHI posture:** persist bidx-only (recommended) vs also store encrypted name/DOB for display.
5. **Match grain:** member-level v1 (recommended); facility refinement v2.
6. **Cadence:** daily (recommended).
7. **Enrichment delivery:** DB views vs app-side joins.

## 10. Sequenced execution (once GO)

1. Confirm decisions + provide secrets.
2. Validate blind-index derivation against known members (GO/NO-GO).
3. Apply migration (`vob.indigo_vob` + `member_benefits_current` + indexes + RLS).
4. Run the initial loader (33,060 rows).
5. QA match rate.
6. Build the enrichment views.
7. Stand up the cron; prove one clean incremental cycle.
8. Hand the seam to the app team for Collections/Qualify UI wiring.

## 11. Recon closeout (0a / 0d / 0f) + finalized DDL decisions (2026-07-22)

**Tenancy — `business_entity_id` deliberately omitted.** `vob.indigo_vob` is a **member-level** table; it stores **no `business_entity_id`**. Tenant scope is inherited from the collections row at JOIN time (`member_id_bidx` is a global blind index, identical across BXR + Indigo), never stored here. `source` records board provenance only (always the Indigo board), not a tenant filter.

**Feasibility GUC caveat.** The 30.8% overlap probe used a raw connection with **no `withTenant`/GUC set**, so it cannot be attributed to both tenants; it is indicative only. Post-load match-rate QA (run with proper tenant context) is authoritative.

**0a — next migration = `0060`.** Evidence: local `supabase/migrations` max `0059`; `origin/main` (HEAD `83af99a`) max `0059`; `git log --all` max `0059`; all 3 other worktrees ≤ `0059` with no ≥0060 files (committed or uncommitted); `docs/veris-data-notes.md` ledger max `0059`.

**0d — CSV = 29 columns (confirmed).** Table carries **28 columns**: match keys + benefit text + provenance. **Excluded from the table by the loader:** `additional_notes` (free-text PHI), raw `patient_name` / `patient_dob` / `member_id` / `group_number` (only their blind indexes are stored), and `relationship_client` / `employer_name` (kept out to preserve a pseudonymous, benefit-only table).

**0f — grant model.**
- **Migration applied by `postgres`** (owns schema `vob`, `rolbypassrls`).
- **Loader connects as `cmd_rollup_writer`** (via `cmd_rollup_writer_login`, pooler:6543). True upsert (`INSERT … ON CONFLICT DO UPDATE`) needs **INSERT + UPDATE** (+ SELECT for readback/QA); 0060 grants all three. PK is text `monday_item_id` → no sequence → no sequence grant.
- **`claims_reader` is SELECT-only and does NOT extend to writes** (confirmed) — it and `consolidated_reader` get SELECT for the enrichment join. The existing collections grant to `cmd_rollup_writer` is INSERT-only; this table's UPDATE grant is a deliberate addition for upsert.

**Dedup recency.** `member_benefits_current` picks the newest VOB per member by `vob_created_at desc` (Monday item created_at, from the roster), tie-break `monday_item_id desc`. `vob_datetime` is unreliable free-text and is **not** used for ordering. The view is `security_invoker = true` so caller grants/RLS apply.

**Drafts (NOT applied / NOT run):**
- Migration + rollback: `VOB-scripts/supabase/0060_vob_indigo.sql`, `…_rollback.sql` (place at `supabase/migrations/0060_*` in the app repo at apply time).
- Blind-index module (validated port): `VOB-scripts/scipts/vob_blind_index.py`.
- Loader: `VOB-scripts/scipts/load_vob_to_supabase.py` (has `--dry-run`; connects as `cmd_rollup_writer`; upsert on `monday_item_id`).

**HOLD:** DDL apply and bulk load are separate GOs pending review of these drafts.
