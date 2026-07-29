---
paths:
  - "src/billingAudit/**"
  - "app/lib/billing-audit/**"
  - "app/components/billing-audit/**"
  - "app/app/billing-audit/**"
---

# Billing Audit (displayed as "Claims Audit")

The billing team's IP/OP claim-audit workbench at `/billing-audit`, replacing CMD
batch reports plus the "JT Master Issues" sheet. Route and internal names stay
`billing-audit`; only the **display label** is "Claims Audit". The name "Claims"
is reserved for Veris S10.

**Currently behind a refactor notice** for everyone except `alec@treathealth.ai`
(`app/lib/billing-audit/maintenance.ts`). Kill switch:
`CLAIMS_AUDIT_MAINTENANCE=off`.

## Scope: TOB-derived on the consolidated feed; roster-implied only on legacy OP

**The consolidated feed (report 10064394, filters B `10148376` + C `10148377`,
live 2026-07-29) derives IP/OP per row from the Type of Bill first-two-digit
prefix** — `{11,86}→IP`, `{13,89,76}→OP`, measured zero-overlap; an unrecognised
prefix QUARANTINES the row and marks the run partial, never defaults a scope
(`deriveScopeFromTob`, `auditRowMap.ts`). One roster
(`AUDIT_CONSOLIDATED_CUSTOMERS`, 17 = 16 data-bearing + WRC expected-empty)
serves both scopes; each customer runs B then C sequentially.

The LEGACY rule — "a row is IP or OP because of which roster its customer sits
in" — now applies only to the still-soaking OP pair (`10073210`/`10147817`,
`AUDIT_OP_CUSTOMERS`): the OP cron stays live and untouched until the
consolidated feed proves 5 clean nights, then decommissions like the IP pair
did (dead since 2026-07-17, cron removed 2026-07-29). During the soak the
consolidated ingest FETCHES but does not WRITE OP-scope rows
(`CMD_AUDIT_CONSOLIDATED_OP_WRITE`, default off) so the two feeds never
co-write a charge.

**Roster exclusions (ruled reality, probes reconfirmed 2026-07-29):**
HOUSTON_MH `10035976` and TREAT_CO `10035974` return INVALID CRITERIA under the
audit filters — operationally unreachable, excluded from every audit roster
("defunct vs new-no-data" unconfirmed at the business level). TEEN MH TX and
WELLNESS RECOVERY are collections-cron exclusions but ARE valid audit customers
(WRC is allowlisted expected-empty). TREAT MENTAL HEALTH VIRGINIA `10036125`
(new customer): INVALID CRITERIA until the saved filters are shared CMD-side —
add only after a rows-bearing probe shown at a gate.

**Row identity (ruled 2026-07-29):** the consolidated ingest upserts on
`(business_entity_id, charge_debit_id)` — the feed's true unique row key — with
a fingerprint-match backfill stamping legacy rows. `row_fingerprint` is
write-once; the fingerprint UNIQUE constraint stays until the OP pair
decommissions (its arbiter). Current-state-only: status history is not kept.

`facilityCode` on this plane is a **log label only**. Row-level facility
attribution comes from the report's Office Name via `claims.facility_alias`,
never from the roster. (`cmd_customer_id` on audit_row is ingest provenance,
same discipline.)

## Config is env-only

Report and filter ids have **no hardcoded fallbacks** here — a missing var throws
at compose time. This is a deliberate break from the collections pattern, whose
in-code defaults are tracked debt we do not replicate. Don't "helpfully" add a
default.

## RBAC

Gated and view-clamped exactly like Collections — not like the old
deploy-protection-only `/claims` page. This plane is PHI: a plain `user` never
gets the reveal control, entity scope comes from the `?view=` switcher, and reads
are tenant-scoped server-side.

Audit data is **BXR-only** today. A non-BXR view resolves to an empty,
fail-closed workbench until that tenant's plane lands — never a cross-tenant
leak. Keep that shape when adding readers.

## Render shape

The server fetches the IP first page for the default (YTD) window plus both
scopes' filter options, so the grid paints with data and the client starts on the
**same** window the seeded page was fetched with — no first-render refetch or
mismatch. OP rows fetch on first view. Preserve that when changing the initial
payload.
