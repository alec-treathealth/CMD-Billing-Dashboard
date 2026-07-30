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

## Rating — value-first, and it stays that way

The rating **is** the facility's dollar-weighted allowed ÷ billed. Full stop. It
is both the list sort key and the badge-color source, and it equals the displayed
`pctAllowedOfBilled`. Volume never bends the score: in RCM the allowed% reflects
the payer's contracted rate, which is stable at low volume, so a small facility
genuinely at 90% is a strong lead.

`rating.ts` computes from `pctAllowed` only — never dollar amounts — so an
`admissions_seat` session derives the identical badge. Keep it that way.

Volume is surfaced as **context, never a penalty**, two ways: a hard floor
(`QUALIFY_MIN_LINES`, applied in `core.ts`) that drops degenerate "100% on one
claim" flukes, and a soft "limited data" flag.

Folding a second signal (denial rate, recency, streak) into the rating is an
explicit v2 decision, not a tweak.

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

- Desktop stale-flash: the qualify tab shows the previous payer's facilities at
  full opacity during an in-flight new search. Pre-existing; accepted.
- Mobile trend-sheet header lacks "City, ST" that the card and detail have.
- Right-swipe has no test — needs jsdom pointer-event infrastructure.
