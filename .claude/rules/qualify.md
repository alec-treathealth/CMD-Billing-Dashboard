---
paths:
  - "app/lib/qualify/**"
  - "app/components/qualify/**"
  - "app/app/qualify/**"
  - "src/collections/qualifyQuery.ts"
---

# Qualify

A cross-tenant admissions lead-qualification surface: `/qualify` (desktop) and
`/qualify/m` (mobile PWA). Distinct from the "Qualify v2 **feed**" series, which
is about `collections.cmd_charge_census` — different thing, don't conflate.

**Currently behind a refactor notice** for everyone except `alec@treathealth.ai`
(`app/lib/qualify/maintenance.ts`). Kill switch: `QUALIFY_MAINTENANCE=off`.

## Authorization

`app/lib/qualify/gate.ts` is the single choke point for every Qualify server
action, and it delegates the pure policy to `principal.ts` so it stays
unit-testable. Only `super_admin` and `admissions_seat` reach Qualify — an entity
`admin` or `user` is denied, fail-closed. Default-deny on no session,
unprovisioned, or any other role.

`admissions_seat` is **server-stripped of every dollar field** (`hasAmounts`,
decided only in `principal.ts`). Anything you add to the payload must respect
that: if a new field carries dollars, it must not reach an `admissions_seat`
session.

`gate.ts` is server-only (it reads cookies + DB). Never import it from a Client
Component — import from `contract.ts` instead.

## The shared contract

`app/lib/qualify/contract.ts` is the single source of truth for the types and
pure window math that desktop and mobile consume **identically**. It is
deliberately not `'use server'` and imports nothing server-only. Semantics are
frozen; rename fields only with sign-off.

Windows are a union: trailing-N-days **or** a calendar month/year — genuinely
different window shapes. Trailing options are 30/60/90 (quick pills) and
180/270/365 (the Range menu, capped at 12 months). Calendar prior-window for any
delta is the **previous equivalent calendar period**, never prior-year-same-month.

## Rating — v2 is the five-factor model (shipped); v1 is value-first

**Shipped `main` sorts and renders `ratingV2`** (`app/lib/qualify/ratingV2.ts`),
not v1. `QualifyFacility.ratingV2` is the sort key and the hero numeral, paired
with `iqBand`, `factors[]` and `availableWeight`. Five factors, weights summing
to 100 and **renormalized over the available set**:

| Factor | Weight | Note |
|---|---|---|
| `coding` | 30 | registry lifecycle × decision age; UNAVAILABLE until the registry is seeded |
| `claims` | 25 | the v1 value-first signal — reliable allowed ÷ billed, tier e2 excluded |
| `dataConfidence` | 20 | sample × window-age × provenance; an auto-widened window costs confidence, visibly |
| `ttp` | 15 | median service→payment days over PAID lines only, and the detail says so |
| `authFit` | 10 | avg LOS vs avg authorized days; overrun-only penalty |

`pctAllowed` null ⇒ the **whole** rating is null. Below
`QUALIFY_RATING_MIN_PATIENTS` distinct patients the rating is null regardless of
factor scores (`sampleGate.ts` is the single source of that floor); factors are
still returned so the card can show what evidence does exist.

The verdict scale is the billing team's own **IQ bands** (65/50/30/15/0, adopted
from the monday census IQ column), not a second Strong/Watch/Weak vocabulary.

**v1 `rating.ts` still exists and is still exported** — `qualifyRating(pctAllowed)
= clamp0to100(pctAllowed)`, buckets 50/30 — for surfaces not yet migrated. Every
v2 surface renders the IQ band. Do not treat v1 as dead, and do not treat it as
current.

**The invariant that survived both models:** every rating input is a percentage,
count, day-count, enum or date string — **never a dollar amount** — so an
`admissions_seat` session derives an identical rating, band and factor list.
`test/qualifyCoreV2.test.ts` proves it at the wire level. Keep it that way.

Volume is surfaced as **context, never a penalty**: a hard floor
(`QUALIFY_MIN_LINES`, applied in `core.ts`) that drops degenerate "100% on one
claim" flukes, plus a soft "limited data" flag.

Folding a second signal into the rating **was** the explicit v2 decision, and it
has been made — v2 folds in coding, data confidence, TTP and auth fit. Adding a
*sixth* factor, or changing a weight, is the same class of decision and needs the
same sign-off; it is not a tweak.

## Sample gate

`sampleGate.ts` tiers a facility by **distinct patients**, not charge lines —
claims within a patient share one plan/contract/CPT pattern and are not
independent draws, so line counts overstate the sample roughly 23×. Its
thresholds (3 / 10) deliberately differ from the movers query's (5 / 10). Both
live in patient-count idiom; don't invent a third.

## Performance

The book-wide KPI aggregate runs on **every** mount, so it must stay an
index-only scan. Migration 0068 built the covering index; 0070 added
`member_id_bidx` to the INCLUDE payload after Phase 2's `count(distinct
member_id_bidx)` broke index-only (52ms/10,837 buffers → 25ms/411 buffers).

**If you add a column to the book-wide KPI query, check the plan.** A column that
is neither a key nor in the INCLUDE payload silently drops the query to a heap
read, and the gap widens roughly linearly with window size — at the 12-month
range that is the ~8.3s → ~40ms class of regression.

Refresh the rollup, then `VACUUM (ANALYZE)` it, or the index-only scan goes cold.

## Deferred / known

- ~~Desktop stale-flash~~ — FIXED, entry removed 2026-08-12 (audit §6 doc-rot finding): v2 clears
  the snapshot before refetch (`qualify-tab.tsx` ~651) and v3 dims + suppresses claims in flight.
  The MOBILE equivalent is still live and is audit finding P1-19 (Wave 4).
- Mobile trend-sheet header lacks "City, ST" that the card and detail have.
- Right-swipe has no test — needs jsdom pointer-event infrastructure.
