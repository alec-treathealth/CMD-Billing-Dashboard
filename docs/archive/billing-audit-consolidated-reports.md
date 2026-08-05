# Billing Audit — consolidated-feed build reports (Items 9 & 12)

Session artifacts, 2026-07-29 build session (consolidated audit ingest on report
`10064394`, filters `10148376` B + `10148377` C). Grounded in the recon record
persisted the same day in `veris-data-notes.md` ("Consolidated audit report
recon — measured (2026-07-29)") — the measured ground truth these reports cite.

**Naming note (surfaced, not silently resolved):** the original build prompt refers
to "the Qualify aggregate view (described in item 9)"; Alec's 2026-07-29 step-3
instruction defines Item 9 as "the ingest delta description." This file follows the
latter. The Qualify-aggregate-view *design* remains owed by the later Qualify
aggregate session, together with recon item 4 a–d (the B+C+rollup slice
reconciliation) — both recorded as outstanding in the ledger.

---

## Item 9 — Ingest delta description (old IP/OP pair-per-scope → consolidated B+C)

### What runs today (pre-cutover)

Two independent nightly crons, one per scope, each looping its LOCKED roster
(`src/billingAudit/auditConfig.ts` — scope IS the roster):

| cron | schedule (UTC) | report/filter | roster | state |
|---|---|---|---|---|
| `billing-audit-ip` | 02:10 | `10064394` / `10147816` (46-col IP projection) | 8 IP customers | **DEAD since 2026-07-17** — INVALID CRITERIA nightly, 13 nights × 8 customers = 104 failures; filter presumed displaced by the creation of the 1014837x filters |
| `billing-audit-op` | 02:20 | `10073210` / `10147817` (39-col OP projection) | 9 OP customers | healthy (~14.4k rows fetched daily) |

Rows land in `claims.audit_row` via `ON CONFLICT (business_entity_id,
row_fingerprint) DO UPDATE` (Option B, 2026-07-13): the fingerprint hashes 15
stable-identity fields; volatile workflow fields update in place. `audit_scope` is
stamped from *which roster* the customer sat in — the report itself never said IP
or OP.

### What the consolidated feed changes

1. **One report, two filters, one run.** Report `10064394` with filter B
   (`10148376`, YTD, all statuses except paid/balance-due-patient) then filter C
   (`10148377`, BALANCE DUE PATIENT only, ~90d) — run sequentially per customer
   (CMD allows one report per partner session; ~16s each, ~34 runs/night across the
   17-customer roster). B and C are complementary status slices, not nested
   windows. Every row is tagged with its `source_filter_id`.
2. **Scope becomes a per-row derivation, not a roster property.** Type of Bill
   first-two-digit prefix: `{11,86}→IP`, `{13,89,76}→OP` (measured, zero overlap;
   the 763 TOB on TREAT_TX is why a first-TWO-digit rule is required). The revenue
   code partition (01xx/10xx vs 09xx) is logged as a consistency check, not a
   second gate. An unrecognised prefix FAILS LOUDLY: the row is quarantined and the
   run is marked — never defaulted into a scope.
3. **Identity moves to the report's true row key** (Alec's Option-B' ruling,
   2026-07-29): `charge_debit_id` (position 4; digits, len 9, 100% fill, unique per
   row across all 16 data-bearing customers; the same identifier space as the
   census feed's Charge ID and `staging.payment_residual.charge_debit_id`). Upsert
   keys on it after a one-time fingerprint-match backfill stamps legacy rows.
   Current-state-only — status history is deliberately NOT kept (future-work
   ledger note: append-only transition table if the desk ever needs history).
4. **New header contract: 42 positional columns** (B and C identical). The dead
   46-col `IP_HEADERS` dies with the IP pair; OP's 39-col set is untouched while
   the OP cron soaks in parallel. Net-new columns worth carrying: Facility NPI,
   Claim Date Entered, Claim First Billed Date (the only status-change anchor,
   1.3% null = entered-never-billed), Patient Admission Date (real episode
   anchor). Dropped: `Last Public FU Note` — the open PHI free-text watch item
   disappears from this feed (a PHI-surface reduction); Claim Diag 4–6 (+POA
   +descriptions); Claim Admit Code. Positional gotcha: modifiers arrive in order
   1, **3**, 2 (positions 27/28/29).
5. **Run identity changes.** One run now covers both scopes:
   `audit_ingest_run.scope` records the FEED (`'CONSOLIDATED'`) rather than a
   derived scope; per-scope row counts live in the run's per-customer detail;
   `source_report_id` stays `10064394`.
6. **Honest empty recording.** A SUCCESS-empty customer records
   `outcome='empty'` AND increments a new `customers_empty` counter on the run
   row; a run where a previously-data-bearing customer (seed expectation = the
   2026-07-29 sweep counts) comes back empty records `status='partial'`, not
   `'ok'`. WRC (documented empty/defunct) is allowlisted as expected-empty.
   Grace stays `CMD_AUDIT_EMPTY_GRACE || 6` (untuned this session; the one
   observed race needed 10 — recorded, not acted on).
7. **Roster = 17**: the 16 data-bearing customers + WRC. HOUSTON_MH (10035976)
   and TREAT_CO (10035974) remain EXCLUDED — reconfirmed INVALID CRITERIA against
   the consolidated pair in a clean CMD window 2026-07-29 (the "defunct vs
   new-no-data" question stays open at the business level; operationally they are
   unreachable). TREAT MENTAL HEALTH VIRGINIA (10036125) is real but the filter
   is not shared/valid under it — INVALID CRITERIA; CMD-side filter sharing is
   the unblock, roster addition deferred to a later gate.
8. **The IP gap closes on the first consolidated run.** IP data stopped
   2026-07-16 (last ok run). B is YTD and re-fetched nightly, so the first
   consolidated run repopulates every IP charge line entered since Jan 1 —
   including the 07-16→cutover window — at *current* status. Under the
   charge_debit_id upsert this lands as clean inserts/updates (no near-dupes).
   What is NOT recoverable: the intermediate status flips that happened during
   the 13 dead nights (current-state-only model; true regardless of identity
   choice).

### Consequences for downstream consumers (feeds the Qualify aggregate session)

- The desk's "current status" is now a property of the row (one row per
  charge_debit_id per tenant), not a max-over-versions query.
- Join universe to rated/collections data: `audit.charge_debit_id →
  cmd_explorer_rows.charge_id → rows.id → rollup.id` — valid ONLY on the
  audit-roster ∩ `BXR_CUSTOMERS` set (TEEN_MH_TX and WRC are audit-only), and B
  joins explorer rows at ~1.1% *structurally* (unpaid claims have no payment
  postings); C joins at ~36.6%, census at 100%. Factor-3-style metrics are
  slice-level ratios permanently.

---

## Item 12 — Consumer-shape enumeration for `claims.audit_row`

Every reader below is PHI-safe by construction: no bytea PHI column
(`patient_name_enc` / `patient_dob_enc` / `member_id_enc`) and no blind-index
token is ever selected into a grid payload; reveal/search run through gated +
audited paths.

### 1. `/billing-audit` — the workbench (display label "Claims Audit")

Currently behind the refactor notice for everyone except alec@treathealth.ai
(`CLAIMS_AUDIT_MAINTENANCE` kill switch). Server Actions in `app/lib/actions.ts`
→ builders in `src/billingAudit/auditQuery.ts`. All queries pin
`business_entity_id = any($n)` (RBAC-clamped view) AND `audit_scope = $n` (the
IP/OP subtab) — **the UI's scope split survives the consolidated feed unchanged
because scope is still a per-row column; only its provenance changes (derived
from TOB at ingest instead of implied by roster).**

- **Work table** — `loadAuditRows` → `buildAuditRowsQuery`: keyset-paged
  `AUDIT_SELECT` projection (28 non-PHI columns: ids, facility_code, office/
  provider labels, payer, status trio, codes/modifiers/units/TOB, auth, 5 dates,
  charge_amount_cents, principal_diag, last_fu_note, ingested_at). Grid shows a
  static patient mask.
- **Filter options** — `loadAuditFilterOptions` → facility options (joined to
  `collections.facilities` for labels) + payer options, per (scope, tenant).
- **Pivot strip** — `loadAuditPivotAction` → three top-8 aggregates (by office,
  payer×CPT, rev code) over the same slice as the table.
- **Patient drill ("claim detail")** — `loadAuditPatientDetailAction` →
  `buildAuditPatientDetailQuery`: one patient's charge lines by opaque
  `cmd_patient_id`, masked, ≤500 lines. This IS the claim-detail surface for the
  audit plane; the old `/claims/[claimId]` route was taken down 2026-07-15
  (redirect stub; "Claims" label reserved for Veris S10) and reads nothing.
- **Gated reveal** — `revealAuditPatientAction`: `canRevealPhi`-gated,
  server-audited (`reveal_audit_row`), id-keyed.
- **Gated search** — `searchAuditPatients`: resolves a term to opaque blind-index
  tokens, audited with field names only.

### 2. Claims Explorer (Collections "All Collections" grid) — NOT an audit_row consumer

`cmd-explorer` reads `collections.cmd_explorer_rows` +
`cmd_explorer_charge_rollup` only. Its link to the audit plane is the shared
identifier space (`charge_debit_id` ↔ `charge_id`), which is a JOIN opportunity
for the later Qualify-aggregate work, not a live read path today. No change lands
on it in this build.

### 3. Flag queue / decision plane — inert placeholder

The Build-6 Flag Queue tab is an empty state; `decisionSync`/`decisionSheet`
(billing-code-decisions cron) write `claims.billing_code_decision` and never read
`audit_row`. Phase-3 flag engine (which WILL read it) is unbuilt, soak-gated.

### 4. Which surface is "Claims Desk"?

**"Claims Desk" maps to the `/billing-audit` workbench** (§1). Reasoning: it is
the only surface whose rows carry billing work-state (`status_category` /
`status_payer` / `charge_status_raw`) and whose population is the biller's
worklist (B = unresolved statuses, C = patient-balance follow-up) — i.e., "the
desk's current status of this charge" from the identity ruling is exactly this
table's row. The Collections explorer is a payment-analytics surface; `/claims`
is a dead route reserved for Veris S10. Any future "Claims Desk" UI work is a
`/billing-audit` evolution, not a new plane.
