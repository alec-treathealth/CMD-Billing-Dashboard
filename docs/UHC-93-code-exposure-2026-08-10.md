# UHC 93-revenue-code exposure — measured against live claims

**Run:** 2026-08-10 · **Deadline:** 2026-10-01 (51 days) · **Source rule:**
`docs/BH-Payer-Policy-Report-All-Payers-2026-08-09.md` §UnitedHealthcare, recommendation #1
**Data:** `collections.cmd_explorer_rows` (646,218 charge lines, 2018-07-31 → 2026-07-28, live CMD ingest)

---

## The answer

**3,354 UHC lines carrying $12.16M in billed charges sit on in-scope revenue codes with no
procedure code.** 2,100 of those lines ($11.1M) are from the last 365 days.

They are **being paid normally today** — 3.0% of them have zero insurance payment, versus 3.7% for
the same codes *with* a CPT. Nothing is being denied for this yet. That is the entire point: this is
**prospective** risk. What pays today becomes ineligible on 2026-10-01.

## What it is, precisely

All of it is three revenue codes, and every at-risk line has the same placeholder in the CPT field
(`—`, CMD's "no procedure code"):

| Rev code | NUBC meaning | At-risk lines | Billed | Last 365d |
|---|---|---|---|---|
| 1001 | Residential treatment — psychiatric | 1,241 | $6.99M | 1,227 lines |
| 1002 | Residential treatment — chemical dependency | 2,011 | $4.57M | 774 lines |
| 1000 | Behavioral health accommodations — general | 102 | $0.60M | 99 lines |

**This is not how we bill residential.** Across all payers, revenue code 1001 carries a valid
CPT/HCPCS on **92.1%** of its 119,386 lines, and 1002 on **74.9%** of 93,426. Omitting the code is a
minority pattern inside a population that mostly gets it right — which means the fix is a known,
already-working behaviour, not a business-model change.

## It started in January 2026

This is a regression, not a standing condition. UHC lines on these codes missing a procedure code,
by month:

| Month | At-risk lines | At-risk billed |
|---|---|---|
| 2025-07 → 2025-12 | 12–64 / mo | $46K–$246K / mo |
| **2026-01** | **225** | **$1.18M** |
| 2026-02 | 413 | $2.22M |
| 2026-03 | 298 | $1.62M |
| 2026-04 | 351 | $1.98M |
| 2026-05 | 340 | $1.83M |
| 2026-06 | 195 | $1.07M |
| 2026-07 (partial) | 89 | $0.48M |

Roughly a **7× jump in lines and 10× in dollars**, sustained for seven months.

## Where it comes from

Two different problems wearing the same symptom:

**A. Never sends a procedure code — a setup gap (100% missing):**

| Facility | At-risk | Billed | Since |
|---|---|---|---|
| COVENANT HILLS TREATMENT CENTERS | 1,672 of 1,673 | $2.62M | 2023-01-01 |
| MH TREATMENT & STABILIZATION CTR OF SACRAMENTO | 78 of 78 | $0.51M | 2026-03-18 |

**B. Regressed — used to send it, stopped (the January break):**

| Facility | At-risk | Billed | Pattern |
|---|---|---|---|
| **REVIVAL MENTAL HEALTH** | 631 of 2,218 (28%) | **$3.38M** | Clean 2023-07 → 2025-12 (0 missing). Broke 2026-01. **Zero-with-CPT every month since February.** |
| MENTAL HEALTH CENTER OF SAN DIEGO | 368 of 4,407 (8%) | $2.15M | All in last 365d |
| SILICON VALLEY RECOVERY | 151 of 3,710 (4%) | $0.90M | |
| VISALIA RECOVERY CENTER | 29 of 113 (26%) | $0.14M | |
| SADDLEBACK RECOVERY | 49 of 359 (14%) | $0.27M | |
| HEALTHY LIFE RECOVERY | 88 of 792 (11%) | $0.50M | |
| + 8 more at 1–8% | 288 | $1.6M | |

**Revival is the single highest-value target**: $3.38M, and it is unambiguously a regression — 2.5
years of clean billing, then a hard stop in January that has never recovered. Whatever changed
there in January 2026 is the thing to find.

## Two caveats that change the number — read before acting

1. **⚠ Applicability to residential is unconfirmed.** The UHC rule as summarised in the source
   report applies to **outpatient UB-04** claims. Revenue codes 1000–1002 are *accommodation*
   codes — normally residential/inpatient, not outpatient. `cmd_explorer_rows` carries no bill type
   or place-of-service, so **I cannot tell from this data whether these lines go out on an
   outpatient UB-04.** If they do not, the exposure is materially smaller than $12.16M. Confirm
   against the UHC Commercial RPUB PDF (linked in the source report) before treating the dollar
   figure as committed risk. Everything else here holds regardless — the lines genuinely have no
   procedure code, and that is worth fixing on its own.
2. **⚠ The code count does not reconcile.** The report says "93 NUBC-silent revenue codes"; its own
   enumerated list expands to **97**. I used the enumerated list (the superset — conservative).
   Reconcile against the source PDF. Note the exposure lands entirely in 1000–1002, so the four-code
   discrepancy does not change this result.

Note also: the report's observation that **090x BH codes are not on the list** is borne out —
our 090x volume is untouched by this. The at-risk population is exclusively the 100x block.

## What to do

1. **Confirm applicability** (caveat 1). One read of the UHC RPUB PDF settles whether $12.16M or
   ~$0 is at stake. Do this first; it is the cheapest step and it gates the rest.
2. **Find the January 2026 change at Revival Mental Health.** Largest single exposure, cleanest
   signal, and a fix there likely explains several of the smaller intermittent facilities.
3. **Fix the two 100%-missing facilities** (Covenant Hills, Sacramento) — these are setup, not
   workflow, and Covenant Hills has been silently doing this since 2023.
4. **Add a standing guard.** A line on a 100x revenue code with no procedure code is detectable at
   ingest. Given this ran for seven months undetected and 92% of comparable lines get it right, the
   condition is well-defined enough to alarm on rather than re-audit later.

## Reproducing this

Every figure above comes from `collections.cmd_explorer_rows`. Definitions used:

- **UHC payer set:** `primary_payer ~* 'united|uhc|optum|umr|oxford|golden rule|all savers|surest|bind'`
  (25 distinct labels; UNITED HEALTHCARE, UMR, OPTUM, SUREST, OXFORD, GOLDEN RULE, ALL SAVERS…).
- **Revenue code normalisation:** stored in both 3- and 4-char form (`100` and `0100`), so
  `lpad(btrim(revenue_code), 4, '0')` before matching.
- **"Has a procedure code":** `cpt_code ~ '^[0-9]{5}$'` (CPT) or `~ '^[A-Z][0-9]{4}$'` (HCPCS).
  Everything else counts as missing. This matters — 8.9% of the whole table has a non-standard
  `cpt_code`, including the `—` placeholder, `INT`/`INTRST` interest lines, and composite values
  like `H2012IOP` / `H2020UHC` (a real HCPCS with a CMD-internal suffix). A naive
  `cpt_code IS NOT NULL` check reports **100% compliance and zero exposure**, which is how this
  nearly got missed.
- **Payment maturity:** the paid/denied comparison windows `charge_date >= 2025-01-01 AND
  < current_date - 120` so immature claims do not read as denials.
