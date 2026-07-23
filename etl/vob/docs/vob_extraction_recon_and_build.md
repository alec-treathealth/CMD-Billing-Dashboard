# Indigo VOB extraction — recon + build report

_Date: 2026-07-22. Board: `1606316049` "All Indigo VOB's" (indigobilling.monday.com), 37,470 items. All figures are coverage/counts only — no PHI._

## Premise correction (why this isn't a column pull)

The task was scoped as "pull benefit data from Monday columns instead of PDFs, retire `extract_vob.py`." Recon disproved the premise: **the Monday benefit/identity columns are empty.** Across a 135-item sample spanning 2022→2026-07-21, every target column read 0% non-null except the item name (patient_name, 100%) and Facility/`status60` (~80%) — including on items created the same day. The benefit data lives only in the PDFs (`files4` "Docs").

**Resulting design:** the PDF extraction (`extract_vob.py` → `indigo_vob_full_extract.csv`) is the source of truth; Monday contributes only **item_id** (join key) and **Facility** (admission gate). `extract_vob.py` was not modified. Assembly is done by `scipts/build_vob_csv.py` (join + gate + curate only; no re-scan, no re-paginate).

## Field-map confirmation (Monday column vs PDF, sampled)

| Output field | Monday column coverage | PDF coverage | Source used |
|---|---|---|---|
| patient_name | 100% (item name) | 98% | PDF (PHI kept local) |
| patient_dob, member_id, group#, relationship, employer | 0% | 98% | PDF |
| insurance_co, payer_id, plan_type | 0% | 98% | PDF |
| policy_type, funding | 0% | 98% / 96% (checkbox→enum) | PDF |
| vob_datetime | 0% (`text_23`) | 95% | PDF |
| additional_notes | 0% | 98% | PDF |
| deductibles / OOP (ind+family) | 0% | 98% | PDF |
| coinsurance (combined) | 0% | 87% | PDF |
| **facility** | **~88%** (`status60`) | n/a | **Monday** |

## Source-of-truth verdicts

- **policy_type (`text_4`)** — Monday column empty → **PDF is the only source.** Derived from the `policy_type_employer` / `policy_type_individual` checkbox pair; exactly one box set on 117/119 sampled (the 2 misses were non-fillable PDFs). Emitted as `Employer` / `Individual`.
- **funding (`text_11`)** — Monday column empty → **PDF is the only source.** Derived from `self_funded` / `fully_insured`; exactly one set on 115/119. Emitted as `Self-Funded` / `Fully Insured`.
- **vob_datetime (`text_23`)** — Monday column empty → **PDF is the only source** (`timdatevob` in V1/V2, combined "Indigo Rep / Date" in V3). 95% present in PDFs.

## 7/10/2026 boundary

Not a backfill cutoff and not where data ends — column population is 0% on both sides, so it is irrelevant to this extraction. What 7/10 marks is recent volume: **559 items created on/after 2026-07-10** (453 admitted, 106 blank-facility), vs 36,911 before. Note these recent items post-date the 2026-07-12 PDF-download manifest, so some lack a local PDF (see gaps below).

## Facility gate

`status60` label extraction is clean. **Blank Facility = awaiting/never admitted → excluded.**
- Admitted (Facility set): **33,060 (88.2%)** → one output row each.
- Blank Facility (skipped): **4,410 (11.8%)**.

Top facilities: My Time Recovery (4,254), Serenity Lodge (2,813), MHC (2,625), Treat MH (2,525), Opus Health (1,924), CCI (1,812), Hillside Horizon (1,772), Saddleback (1,635), 405 (1,456), CA Mental Health (1,441)…

## Final field list (curated core, 29 columns, deterministic order)

`_monday_item_id`, `facility`, `patient_name`, `patient_dob`, `member_id`, `group_number`, `relationship_client`, `policy_type`, `employer_name`, `funding`, `insurance_co`, `payer_id`, `plan_type`, `vob_datetime`, `additional_notes`, `ind_deductible`, `ind_deductible_met`, `family_deductible`, `family_deductible_met`, `ind_oop_max`, `ind_oop_met`, `family_oop_max`, `family_oop_met`, `coinsurance_combined`, `coinsurance_ip`, `coinsurance_op`, `coinsurance_after_oop`, `_schema_version`, `_extraction_flag`.

**Dropped** per sign-off (no structured PDF source — checkbox/method only, not amounts): `mrc_1`, `mrc_2`, `cigna_reimb`, `aetna_reimb`, `uhc_reimb`, and per-LOC dollar rates.

## Row-count reconciliation

| | count |
|---|---|
| Board items (roster) | 37,470 |
| — Blank Facility (skipped) | 4,410 |
| **Admitted → rows written** | **33,060** |
| of which: clean extraction | 28,959 (87.6%) |
| of which: UNRECOGNIZED_SCHEMA_VERSION (best-effort + flagged) | 2,824 (8.5%) |
| of which: NOT_A_FILLABLE_FORM (scanned/image PDF) | 679 (2.1%) |
| of which: NO_PDF_EXTRACT (admitted item, no local PDF) | 591 (1.8%) |
| of which: EXCEPTION (corrupt PDF) | 7 |

Output CSV parses to exactly **33,060 rows × 29 columns**, uniform width. Per-field non-null coverage ≈ **96%** on all core fields (the ~4% gap = the flagged/no-extract rows). Empty → null (empty cell).

## Known gaps (for a follow-up, not blocking)

- **591 admitted items have no local PDF extract** — they post-date the 2026-07-12 download manifest or failed download; need a targeted `files4` re-fetch + extract.
- **~3,510 flagged rows** (UNKNOWN schema + non-fillable + exception) extract partially or not at all. Per decision, run + flag; review the flagged subset. UNKNOWN ~8.5% suggests a 4th PDF schema variant worth mapping if higher fidelity is wanted on that slice.

## Output & PHI handling

- Clean PHI output: `/Users/aleclowi/vob-data/indigo_vob_curated.csv` (outside the repo, gitignored, not committed). This file IS PHI.
- Monday pulls were metadata-only (item_id + Facility); no patient data left Monday. All PHI (name/DOB/member_id/notes) came from the local PDF extract.

## Supabase load readiness (one line)

**Ready to design the load** — a self-contained 33,060-row curated CSV exists and reconciles; next gated step is the Indigo-scoped (`141d459c-…`) tenant load through the PHI pipeline, after you inspect the CSV and decide whether to first backfill the 591 missing-PDF items.
