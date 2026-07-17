# Qualify — session handoff (2026-07-17)

Paste-ready continuation prompt for a fresh session. Everything below the rule is self-contained; a
new session should need zero re-discovery. Companion tribal-knowledge lives in
`docs/veris-data-notes.md` (Qualify entry + the migration reservations ledger) and the auto-memory
`qualify-build-series`.

---

**Qualify feature — status & continuation.**

**What shipped (live on `main`, deploy-green):** A cross-tenant admissions lead-qualification surface.
`admissions_seat` role (migration 0055, applied). One frozen backend contract —
`getQualifySnapshot` / `getQualifyMovers` — reads BXR + Indigo pinned (Finding 2a), gated to
`{super_admin, admissions_seat}` (Q-A). **Desktop `/qualify`:** rating-ranked **"Heating up"** facility
panel (top 10; volume-dampened rating, cutoffs 26/38 from `rating.ts`), cases table with per-row
**audited PHI reveal** (fetch-once-per-session → one audit per row per session; toggle hides only),
amounts DOM-omitted for `admissions_seat`. **Mobile PWA `/qualify/m`:** 5-row sliding **swipe-list**
(left = pass, right = trend-details sheet, tap = payer-wide detail), light theme, **"Heating up"**
movers module (informational chips), scoped manifest + service worker (caches only `/_next/static`,
never the data path / PHI). Reveal ⊥ amounts: an `admissions_seat` can reveal PHI and still sees zero
dollars (both gates independent, tested).

**Open / deferred:**
1. **Per-facility cases query** — desktop + mobile both show **payer-wide** `cases[]` (ruling Q3),
   labeled honestly ("recent claims for this payer"); per-facility scoping is a future *gated* task with
   desktop-parity implications, structured so it drops in without a UI rebuild.
2. **Streak badge** — omitted (v1); `streakSignal` stays null. A real badge needs a **v2 posting-grain
   monthly aggregate** off `cmd_explorer_rows` (the 0050 charge-rollup's `max(payment_received)` cannot
   back a faithful monthly trend).
3. **Mobile "Heating up" chips** — **informational only** (final). The contract resolves a payer from a
   member-id / alpha-prefix token, not a payer name; resolve-by-payer would be a contract addition.
4. **VOB "Start VOB" CTA** — inert, `// TODO(qualify-vob)` seam, pending a real target (Monday board /
   n8n webhook).
5. **Migrations** — 0055 (`admissions_seat_role`) and 0056 (`access_audit_reader`) applied + on `main`.
   **Next free dashboard migration = 0057.**

**Files (zero re-discovery):**
- Contract/logic: `app/lib/qualify/{contract,principal,gate,core,actions,rating,facilityLocations}.ts`,
  `src/collections/qualifyQuery.ts`, `app/lib/qualify/m/swCachePolicy.ts`.
- Desktop: `app/app/qualify/page.tsx`, `app/components/qualify/*` (`qualify-tab`, `facility-panel`,
  `cases-table`, `vob-modal`, `colors`).
- Mobile: `app/app/qualify/m/*` (`page`, `layout`, `manifest.webmanifest/route.ts`, `sw.js/route.ts`,
  `icon.svg/route.ts`), `app/components/qualify/m/*` (`qualify-mobile-app`, `swipe-row`, `trend-sheet`,
  `detail-sheet`, `heating-up`, `sw-register`, `icons`, `colors`).
- Nav/chrome: `app/components/nav-links.tsx` (role-aware, Qualify NEW flag), `app/components/header-gate.tsx`
  (hides global header on `/qualify/m`).
- Tests: `app/test/qualify-render.test.tsx` + `app/test/qualify-mobile-render.test.tsx` (rendered-markup;
  need `app/tsconfig.test.json` `jsx:react-jsx` via `TSX_TSCONFIG_PATH`), `test/qualify{Query,Rating,Gate,Core,Colors,SwCache}.test.ts`.
- **Verify gates:** root `npm run typecheck` **AND** `cd app && npm run typecheck` (they differ on
  `noUncheckedIndexedAccess` — a test can pass `npm test`/`next build` while root `tsc` is red), root
  `npm test`, `cd app && npm test`, `cd app && npm run build`.

**Provisioning reminder:** as of Prompt 2's verification there were **0 `admissions_seat` rows** in prod —
the first real seat is a manual super_admin action (Manage Users → invite). It's now unblocked (both
surfaces live). Confirm the seat exists before relying on any `admissions_seat` live behavior; the
cross-tenant-PHI capability is inert until then.
