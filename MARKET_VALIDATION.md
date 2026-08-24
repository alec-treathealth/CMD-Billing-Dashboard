# Validation Memo — Pre-Admission Financial-Clearance / Payer-Operability Thesis

**Prepared for:** Alec Lowi (Quickstart Health) · **Date:** 2026-08-13
**Method:** read-only queries against the live Supabase cluster (`cmd-billing-dashboard`, `vob-dashboard`, `cmh-kipu-dashboard`), CMS NPPES, and primary regulatory sources. No writes to Kipu / CollaborateMD / any payer system. Every distribution below shows its n. Aggregates only — no PHI left the database.

---

## Bottom line (read this first)

The report is directionally right about the *market* and mostly right about the *risks*, but it is aimed at the wrong **leak**. Your denial dollars are not a pre-admission authorization problem — they are an out-of-network **pricing and coverage** problem, post-adjudication. A pre-admission *authorization*-clearance tool addresses **0.6%** of your measured denial dollars. Build OON expected-reimbursement + denial/underpayment recovery on the data you already own (and already partly modeled in Qualify). Do not build an auth-clearance gate as the wedge.

Three things you should know before reading the table:

1. **Your raw-835 corpus is 6 weeks old** (450 remits, 2026-07-07→08-17). The "trailing 24 months from actual 835s" the brief asks for does not exist as raw 835s. The 24-month denial/AR history lives only in CMD-*derived* CARC tables (`staging.era_adjustment`, n=65,615; `staging.claim_line`, n=150,900, 2023→2026). I used those and labeled them as derived, not raw 835.
2. **IN-vs-OON is not a field.** `payer_dim.network_status` = "Unknown" for all 286 payers. The book is OON-dominant by every proxy (7–16% paid-of-charge; the dominant denial CARC is literally "no negotiated rate on file"), but a precise IN/OON dollar split is not computable from a structured column.
3. **LOC is not a field either.** I derived it from rev/HCPCS codes using standard NUBC/HCPCS semantics. Treat the LOC cuts as a documented heuristic, not ground truth.

---

## (a) Claim → verdict → evidence → what it changes

| # | Report claim | Verdict | Evidence (from our data / primary source) | What it changes |
|---|---|---|---|---|
| 1 | Problem is acute & expensive (BH denials, AR, $24–45K/RTC episode) | **CONFIRMED (market)** | Book is OON-dominant: paid-of-charge 7–16% across all major families; residential per-diem is 71% of collections ($50.6M of $71.5M paid, `claim_line`). Denial-type CARCs = **$14.2M** over 3yr (`era_adjustment`, 9,961 lines). | Keep going — the pain is real and concentrated in OON residential. |
| 2 | Winning product = pre-admission **financial-clearance** workflow | **PARTIAL** | The *reimbursement-prediction* half is supported (item 7 variance). The *authorization-clearance* half is not: auth denials = $91K/3yr (below). | Split the concept. Keep expected-OON-reimbursement at intake; drop "authorization clearance" as the value prop. |
| 3 | 271 / machine-readable data can't answer "LOC covered / PA required" | **UNVERIFIABLE (here) — and worse than the report thinks** | We store **zero** 271 responses. `vob-dashboard` is Monday ticket metadata (`monday_id, name, insurance, vob_date`) with **no benefit fields**. 37,816 VOB *tickets*, 0 structured EB segments. | The thesis's single decisive test *cannot be run on our data*. You must capture raw 271 before betting on it. |
| 4 | QPA-from-own-contracted-rates is invalid | **CONFIRMED** | Methodologically correct (QPA = payer's 2019 median, 45 CFR 149.140). Also moot: `network_status` Unknown, no contracted-rate table exists to misuse. | Kill `qpa_estimate` (already on your do-not-build list). Non-issue for us. |
| 5 | Kipu is both data pipe and competitor | **UNVERIFIABLE (commercial)** | Out of scope for our data. Note: our Kipu integration (`cmh-kipu-dashboard`) covers **one** instance (76 patients, 210 UR rows), so the dependency is real but shallow today. | Confirm API terms/BAA in writing (see §e). |
| 6 | Leak is auth friction / concurrent review / OON volatility | **REFUTED → OON pricing only** | Of the $14.2M denial leak: **71% ($10.0M) network/OON-pricing CARCs (147, 242, 279); 21% ($2.9M) non-covered (96, 204); 8% ($1.08M) benefit exhaustion (119, 35). Pre-admission auth (197/15/39) = $89K (0.6%). Concurrent-review / medical-necessity CARCs (198, 50, B7) = $0** across the full 3-yr history. | **This is the headline.** The leak is OON pricing + coverage, not auth, not concurrent review. Re-aim the product. |
| 7 | OON variance wide enough for regime-and-range (not a lookup) | **CONFIRMED** | Residential per-diem (H0018) realized $/day by payer: within-payer CV **0.31–0.76**, IQRs 2–3× (Anthem $1,406→$3,600; range $8→$5,795), cross-payer medians $1,443 (Aetna) → $2,991 (Cigna). n=1,700–3,500 per major payer. | Build ranges-with-confidence, not point estimates. But condition on plan/deductible — much of the CV is plan mixing, not payer caprice. |
| 8 | SCA outcomes not structured in CollaborateMD | **CONFIRMED** | `negotiation_worklist` = **16 rows**, all inserted in one 16-second batch 2026-06-14 — a seed, not a log. Has `negotiated_pct` (0.27–0.50), no request date / outcome / cycle time. SCA lives in claim workflow statuses ("NEEDS RENEGOTIATING" 1,030; "APPROVED FOR HIGHER PAYMENT" 1,634) and Monday/email. | `sca_history` is a manual-capture build, not an API pull. Approval rate / cycle time are not computable today (n=16 is not a rate). |
| 9 | BH benefits carved out to an MBHO (271 = wrong source) | **PARTIAL / directionally CONFIRMED** | `ref.payer_identity.entity_kind`: 9 explicit `carve_out`, but **112/188 (60%) `unclassified`**. Explicit carve-out volume ≈ Optum $21M + Magellan $17.3M ≈ 6% of charge — understated, because Anthem/BCBS/Cigna/United BH is often administered downstream by Carelon/Optum without showing on the claim. | Carve-out is material but the true share is unknowable from our data. Reinforces: don't trust the parent carrier's 271. |
| 10 | Self-funded status often not determinable | **CONFIRMED** | No funding-type field anywhere. `ref.plans` empty. `employer_name` populated 8.7%, `group_number` 26.5% (`claims.claims`, n=320,116) — neither establishes funding. | ERISA-preemption branch of the OON classifier must be human-entered. |
| 11 | TiC MRFs unreliable for BH (ghost rates) | **PARTIAL (unverifiable-here) → refuted for OON use** | Can't compute a code-coverage rate in-session (MRFs are 100s of GB). But structurally moot: CARC 147 "negotiated rate **not on file**" = $5.85M of our denials — proof these payers have **no** contracted rate for us, so their *in-network-rate* MRF has no row for our (facility, code) pairs by definition. CRS R48570 documents the ghost-rate usability failures. | MRF is near-useless for OON pricing here. Weight our own 835 paid amounts; don't invest in MRF ingestion. |
| 12 | NSA rarely applies to our admissions | **CONFIRMED (primary source)** | 45 CFR 149.30 defines NSA non-emergency "health care facility" as *only* hospital, HOPD, critical-access hospital, ASC. Our facilities are freestanding (NPI 1356110837 = 323P00000X "Psychiatric Residential Treatment Facility"; NPI 1508756743 = 320800000X "Community-Based RTF, Mental Illness"). Non-emergency OON admissions to an OON freestanding facility are none of the three protected categories. | `nsa_facility_based` regime effectively never fires. Dominant regimes: `default_ucr`, `state_specified`, `behavioral_health_sca`. Detox-as-emergency is a rare edge; confirm with counsel. |
| 13 | Buyer = PE platform CFO / multi-site operator | **UNVERIFIABLE (strategy)** | Not answerable from data. Flag: your systems serve QSH's *own* facilities — if the customer is QSH-internal, the report's external-PE-buyer framing and pricing ($3–8K/mo/operator) don't apply. | Decide internal-tool vs external-SaaS before productizing (see §e). |
| 14 | Days-in-AR ~52; denial ~11.8% | **UNVERIFIABLE as apples-to-apples** | Our time-to-payment on **paid** lines: median ~31d, avg ~45d (Cigna 20d median, Aetna 35d, Commercial 51d), n=81,313. That is *not* days-in-AR — it excludes unpaid/limbo claims (survivorship). Denial "rate" has no honest denominator (adjustment tables exclude clean-paid claims; no first-pass adjudication feed). | Don't claim "we beat 52 days." Add true AR-aging + first-pass acceptance instrumentation before comparing. |

---

## (b) The three findings that most change the build decision

**1. The leak is OON pricing, not pre-admission authorization (item 6).**
Across the entire 3-year CARC history, pre-admission auth denials (CARC 197/15/39) total **$89K** and concurrent-review/medical-necessity denials (CARC 198/50/B7) total **$0**. The $14.2M denial leak is **71% out-of-network pricing** (rate-not-on-file / not-a-network-provider) and **29% coverage/benefit-exhaustion**. A pre-admission *authorization*-clearance product is a solution to a problem you do not measurably have. What you have is an OON-pricing and denial-recovery problem, post-adjudication.

**2. You cannot test the machine-readable core of the thesis, because you capture no 271s (item 9).**
The report's own "single decisive test" — do 271s return LOC-specific benefits / PA requirements / visit limits — is unrunnable here. There are zero structured eligibility responses in any project; the "VOB dashboard" is Monday ticket-tracking metadata with no benefit fields. Any roadmap that depends on machine-readable payer truth is currently betting on data you neither hold nor have proven obtainable. Step one is a 271-capture pilot to run the test before committing.

**3. The "policy rating engine" the report warns against is already built — and it's the moat the report recommends.**
`collections.qualify_policy_rating_daily` holds **218,367 rows** of a five-factor policy rating (pct_allowed, days-to-payment, confirmed-claims, distinct-members) per (member-prefix, payer) on *your own* claims. That is precisely the "longitudinal, normalized, operator-specific payer-behavior graph" the report names as the durable moat — not a new thing to build, an existing thing to extend. The report says "don't build a rating engine, build the payer-operability graph"; you've effectively built the graph and are calling it a rating. Lean in, keep it decision-support/human-in-the-loop, and drop the "rating" label externally (SB 1120 optics).

---

## (c) Revised build order (only work that survived validation)

**Build now — validated against the actual leak:**

1. **OON expected-reimbursement ranges** per (payer family, plan/deductible where known, LOC, top code) — extend Qualify. Justified by item 7 (CV 0.31–0.76, wide, n large). Output a range + confidence, never a point estimate. This is the defensible half of "financial clearance": what will we collect if we admit this member.
2. **Denial-dollar recovery worklist** targeting the real $14.2M: CARC 147/242 (OON rate/network, $10M), 96/204 (non-covered, $2.9M), 119/35 (exhaustion, $1.08M). Extend the existing `payment_residual` gap-miner (BALANCE_DUE_INSURANCE). Fastest ROI, uses data you own.
3. **Structured SCA capture UI** (human-curated), because OON single-case negotiation *is* your lever and it's currently unstructured (item 8). Capture request→outcome→negotiated_pct→cycle time so approval rate becomes measurable.
4. **271-capture pilot** — start persisting raw 270/271 from CMD/clearinghouse for the top 3 payers, then run the report's LOC/PA/limit test on real responses (item 9). Gate any machine-readable roadmap on the result.
5. **Human-entered ERISA/self-funded + benefit-exhaustion flags** on the case (item 10/11) — not computable, so make them fields.

**Compliance-blocked / do-not-build (honored):**

- QPA-from-own-rates estimator — **killed** (item 4).
- ML for regime classification or arbitration outcome — **rules only, auditable**.
- Payer-portal scraping behind a login — **excluded**; use X12/clearinghouse + manual-with-evidence.
- Any auto-approve / auto-submit / auto-reserve / ability-to-pay screen — **excluded** (SB 1120 / EMTALA-adjacent optics).
- **Gate before any SUD-identifying data flows to Monday**: Part 2 consent chain + Monday Enterprise BAA + HIPAA mode (item in §a-3 and §d). Today patient names sit in `quantum_vobs.person_names` and Monday admissions/census boards — SUD-associated, 42 CFR Part 2.

**De-prioritize:** pre-admission *authorization* clearance as the wedge — addresses 0.6% of the leak.

---

## (d) 90-day proof metrics

**Measurable now with existing instrumentation:**

- **Denial-leak baseline & recovery** — $14.2M denial-CARC total; track recovered $ on CARC 147/242/96/119 (`staging.era_adjustment` + `payment_residual`).
- **OON realized per-diem variance & expected-vs-actual** per payer×LOC (`claim_line`, `cmd_explorer_rows`).
- **Time-to-payment on paid claims** by payer (`claim_line.total_time_to_payment`) — median ~31d baseline.
- **Underpayment worklist throughput** — BALANCE_DUE_INSURANCE residual worked/closed.

**Requires new instrumentation (name it, don't fake it):**

- **True days-in-AR** — open-balance aging (not time-to-pay on paid claims). Needs an AR-aging job.
- **First-pass clean-claim rate** — needs 277CA/999 acceptance capture from the clearinghouse; not stored today.
- **SCA approval rate & cycle time** — needs the structured SCA capture (build #3).
- **271 EB-segment richness** — needs the 271-capture pilot (build #4). This *is* the go/no-go for the machine-readable roadmap.
- **Lost-admission rate & reason** — not tracked anywhere I can query with a structured loss reason; lead status lives in Monday/CallRail without a reason taxonomy. Per your ground rule: **"reduced lost admissions" is not a measurable proof metric today** — I'm not proposing a proxy. It needs conversion tracking built in the admissions pipeline.
- **Concurrent-review leak (authorized vs delivered days)** — Kipu UR has `number_of_days` + LOC but only one instance (n=210, `ur_date` null) and isn't joined to claims. Needs all-instance Kipu UR joined to billed days.

---

## (e) Questions only you, counsel, Kipu, or CollaborateMD can answer

- **[Counsel]** Does the 42 CFR Part 2 consent chain cover SUD-identifying data currently flowing to Monday, Make, Gmail, and OpenAI (per your own CRM PRD)? Is Monday on Enterprise + signed BAA + HIPAA mode? Is the OpenAI email-parsing path under a BAA? *This gates any admissions-side build.*
- **[Counsel]** Per-state balance-billing exposure for freestanding OON BH in CA, TX, TN, KY, NV, WA, MO — and confirm the detox-as-emergency edge (does acute withdrawal ever trigger NSA emergency-services protection for you?).
- **[CollaborateMD]** Does CMD expose raw 270/271 eligibility responses and 277CA/999 acceptance via API/export? Are any SCA/auth outcomes held as structured fields, or only notes?
- **[Kipu]** Do the API terms + BAA permit a downstream normalized data layer? Which instances expose UR authorized-days and occupancy/beds (only one is integrated today)?
- **[You]** Is the book truly ~100% OON, or are specific payer/facility pairs contracted? `network_status` is Unknown for all 286 payers — I can't tell from data.
- **[You]** Who is the customer — QSH internally, or an external multi-site/PE operator? The report's buyer, pricing, and "cross-operator federated moat" all assume external; your stack looks internal. This changes the entire commercial model.

---

## Method & sample-size notes

- **Raw 835:** `staging.era_835_payment` n=450 envelopes, 29 payers, 2026-07-07→08-17 (6 wks). Denied claims (CLP02=4) n=53. Too thin for payer-level denial benchmarks — flagged wherever used.
- **Denial analysis** uses CMD-derived CARC (`staging.era_adjustment`, n=65,615 rows / 9,961 denial-category lines, service 2023→2026), not raw 835. The `category` field is CMD/Brain's own classification; I re-derived the mechanism split directly from raw CARC codes verified against `ref.carc_code`.
- **LOC** is a derived rev/HCPCS heuristic (H0018/H0019/H0017→residential; S9480/H0015→IOP; H0010→detox; 90853/90837→ancillary). No LOC field exists.
- **Days-to-payment** is on paid lines only (survivorship-biased; understates true AR).
- **IN/OON** inferred from paid/charge ratios + dominant OON CARCs; `network_status` is unusable ("Unknown" ×286).
- **Carve-out share** understated — `entity_kind` 60% unclassified.

**Sources:** live Supabase (`cmd-billing-dashboard`, `vob-dashboard`, `cmh-kipu-dashboard`); [CMS NPPES NPI Registry](https://npiregistry.cms.hhs.gov/); [45 CFR 149.30 (eCFR)](https://www.ecfr.gov/current/title-45/subtitle-A/subchapter-B/part-149/subpart-A/section-149.30); [CRS R48570 — Technical Challenges with Private Health Insurance Price Transparency Data](https://www.congress.gov/crs-product/R48570); [Federal Register — Transparency in Coverage (2025 proposed amendments)](https://www.federalregister.gov/documents/2025/12/23/2025-23693/transparency-in-coverage).
