# Qualify × Smoke — mockup notes (design/qualify-smoke-shell)

**Mockup:** `docs/mockups/qualify-smoke.html` — open directly in a browser. Static,
self-contained, synthetic data only (every member handle is invented and masked;
facility/payer names are business entities, not PHI). No app code touched.

**Tree:** `design/qualify-smoke-shell` off `origin/main` @ `581483e`, worktree
`/Users/aleclowi/wt-qualify-smoke` — deliberately separate from every live session
branch so the two directions can be compared later.

## What the mock encodes (the ratified ideas)

1. **The lane (left rail).** One search = one guardrailed swimlane. The horizontal
   stepper IS the v3 staged flow (Identify → Carrier → Plan → Answer) turned into a
   timeline; completed stages collapse into the receipt checklist (smoke's
   "Setting up…" card). The lock strip states the guardrail; the answer footer
   restates it ("answered from 347 matched lines, nothing outside the lane").
2. **Fill-in-the-blank chips (Phase 2 posture).** Chips are sentence TEMPLATES whose
   only editable parts are enum SLOTS (styled selects). The composer at the bottom is
   the same grammar. What would reach the server: template id + slot values — user
   prose structurally cannot. Chips are DERIVED from what the search returned
   (aiChips.ts already does this today); the ✦ suggested chip keeps that convention.
3. **The tape.** Two marquee lanes: prefixes/policies (top 20, dark inverse surface,
   faster — 34s loop) and facilities heating up (light surface, slower — 52s).
   Deltas are 60d rating movement, stock-tape idiom. Pauses on hover; becomes a
   scrollable strip under prefers-reduced-motion.
4. **Drill left → resolve right.** The board's "This search" zone fills per stage:
   empty → matched strip (prefix, carrier count) → payer hero + on-file chips →
   KPI triplet + ranked facility scorecard + AI stream. Click the stepper or
   ⟲ Replay to watch the progression.
5. **Watchers.** Right side persists past searches two ways:
   - **Trendwatchers** — a prefix/payer with sparkline + Δ and an alert threshold.
     Non-PHI (payer label + prefix), can persist server-side per user.
   - **Patient watchers** — persist the keyed-HMAC blind-index TOKEN + a masked
     display echo (`GGS •••• 8841`), never the raw member ID. The footer line in the
     mock is the compliance contract, not decoration.
   - **Recent searches** — non-PHI facets only (payer · prefix-echo · plan class ·
     timestamp), re-run resolves fresh.

## Phase plan (agreed 2026-08-08)

- **Phase 0 — tokens.** `tokens.json` (merged TreatHealthOS × Smoke set) →
  Style Dictionary → `tokens.css` + TS module + Tailwind fragment. The mock's
  `:root` block IS the compiled form (names: `color.surface.canvas` →
  `--color-surface-canvas`). Needs: dual hex+HSL-triplet emit for the shadcn vars;
  per-tenant `--brand-*` modeled as theme sets, not flattened. CI parity check à la
  `check-context-map`. Light mode only — dark set deferred.
- **Phase 1 — the shell.** Two-pane layout on /qualify; rail wraps the existing v3
  stage machine + GSAP motion (both already shipped); board hosts tape/zone/watchers.
- **Phase 2 — slot-chip AI.** Chip templates + slot enums through the existing
  zod-strict firewall (new template-id field on `QualifyAiInput`); no free text.
  **Chip-driven, light mode — Alec's call, 2026-08-08.**

## Backend seam — status 2026-08-08 (Alec: 90d delta, proceed)

The search logic is being rewritten (another session). Everything below the
"SYNTHETIC FIXTURE" comment in the mock's script is the seam: stage events in,
board sections out. UI build proceeds; the LANE binds to the rewrite when it lands.

**BUILT on this branch (2026-08-08) — the tape is no longer parked:**
- **Mig 0093** (`supabase/migrations/0093_qualify_rating_history.sql`, NOT applied):
  `collections.qualify_policy_rating_daily` (one row per active prefix-token × payer
  per day — the five-factor policy rating + the claims aggregates that fed it),
  `collections.qualify_rating_run` (catch-up ledger), and
  `collections.qualify_prefix_echo` + SECURITY DEFINER
  `collections.record_qualify_prefix_echo(token, echo)` — the echo seam the search
  rewrite calls at term-mint time so tape items gain their 'GGS' labels.
- **Nightly cron** `/api/cron/qualify-rating-history` (daily 05:10 UTC, DB-only):
  self-healing catch-up over a 180-day horizon — the FIRST run backfills ~180 daily
  snapshots so the 90d delta works immediately. Backfill is a disclosed
  reconstruction: claims factors are exact as-of; coding/census context is
  current-state (see qualifyRatingHistory.ts header). Rating parity by injection:
  app/lib/server.ts wires the real computeRatingV2 + derivePolicyRating.
- **Tape read API**: `getQualifyPolicyTape()` (app/lib/qualify/board-actions.ts →
  board.ts core → loaders.ts `loadQualifyPolicyTape`, fail-soft while 0093 is
  unapplied). Reads as of YESTERDAY's close (the newest fully-ingested date).
  Top 20 by |Δ90|, member floor 3, NON-DOLLAR payload
  (`QualifyPolicyTapeItem`: token, tokenTail, echo, payer, ratingNow/Then, deltaPts,
  members, lines). **This is the contract the new UI's prefix tape binds to.**

**UI binding map (mock element → data source):**
- Prefix/policy tape → `getQualifyPolicyTape()` (READY once 0093 applied + cron ran)
- Facilities tape → `getQualifyFacilityTrends()` (already live)
- Lane / stepper / receipt → `resolveCoverageAction` (v3) — REBIND after the rewrite
- AI chips/composer → `generateQualifyAiExplanation` + aiChips (live; slot grammar TBD)
- Echo labels on tape items → arrive when the rewrite calls
  `record_qualify_prefix_echo` (until then the UI shows `⋯` + token tail)

Still parked (unchanged):
- Watchers need a `collections.qualify_watchers` table (user, kind, hmac_token/
  payer_key, masked echo, threshold) — RLS per user; own scoped session.
- "Patient watcher" alerts ("new ERA posted") imply joining era-835 output against
  watcher tokens — feasible via the same blind index, needs its own scoped session.
- Recent searches: terms are unrecoverable from claims.access_audit BY DESIGN —
  persistence is an audit-policy decision, not just an action.
