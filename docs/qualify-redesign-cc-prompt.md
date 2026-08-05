# QUALIFY REDESIGN — CC BUILD PROMPT (wire the approved mockup into production)

Paste into Claude Code on `main`. Gate-review discipline: FIRST OUTPUT is a plan +
artifacts; STOP for Alec's go before writing code. HOLD before every migration and
before every commit. Never add a `Co-Authored-By: Claude` trailer.

---

## ROLE & DISCIPLINE

You are a senior engineer embedded with Alec on CMD-Billing-Dashboard (main, production).
Read IN FULL before touching anything: the root `CLAUDE.md` (+ `.claude/rules/qualify.md`),
`docs/design-system.md`,
`docs/qualify-build-series.md`, and the RULINGS section of this file.
`docs/Fable Build Doc E2E/00-GUIDE.md` and `veris-data-notes.md` are the standing
operator / reconciliation guides — skim for conventions; they do NOT govern this Qualify
redesign (see RULINGS · Doc paths). Surface — never silently resolve — any conflict between
those docs and what you observe.

Non-negotiable (HIPAA / SOC 2 / OWASP, always on):
- PHI (patient_name, member_id, group_number, **client name**) never in logs, prompts, URLs,
  or summary objects. Parameterized queries + column allowlists only. Pooler port 6543 — no
  named prepared statements. `claims_reader` least-privilege.
- Dollar amounts stay authorization-gated exactly as today: stripped **server-side** for
  non-capability sessions (the existing `super_admin` check / `viewerHasAmountsCapability`).
  Never CSS-hide a shipped value.
- Cross-tenant is deliberate: every Qualify query reads
  `business_entity_id = ANY(ARRAY['af504ab6-…BXR'::uuid,'141d459c-…Indigo'::uuid])`.
  Keep the commented exception at every query site.
- Every PHI reveal is audited (synchronous audit log), including under the new global-reveal
  mode below.

## VISUAL + INTERACTION SPEC

`docs/mockups/qualify-redesign-mockup.html` is the approved comp (open it — desktop + mobile
via the top toggle; fictional data only). Match its structure and feel, adapting field names
to the real contract. It supersedes the older `qualify-tab-layout-proposal.html` (deleted 2026-07-28).

Canonical fonts (already in `tailwind.config.ts` / `globals.css`): **Inter** body ·
**Space Grotesk** head · **Fraunces** display · **IBM Plex Mono** numeric. ("Hanken Grotesk"
in the old build-series doc was never real — ignore it.)

## SCOPE

IN: the desktop `/qualify` tab and the mobile `/qualify/m` PWA — restyle + restructure to the
mockup, plus the four behavior changes below. Shared design tokens so the two surfaces stop
diverging.
OUT: rebuilding the server contract wholesale. Where the mockup shows data the contract does
not expose yet (flagged below), HOLD and confirm the contract addition before faking it.

---

## RULINGS (DECIDED — do not re-ask; these resolve the open questions from your first output)

- **Doc paths:** not blocking (see ROLE above).
- **KPIs (allowed / paid / collected):** BUILD NOW, in-plane — derive from
  `cmd_explorer_charge_rollup` (`insurance_payments` is already there, 0059). Return
  percentages only; dollars computed server-side (cohort pattern) so `admissions_seat` stays
  safe. The mockup's "needs collections data" caption is WRONG — no external join.
- **Trend + Δpts / Heating-Up:** BUILD NOW — `buildFacilityTrendQuery` (weekly buckets +
  prior-equal-window Δ). Powers the sparklines AND the Heating-Up sort.
- **Employer tab:** v1 = wire to the existing `QualifyMarket.employers` narrow (a filter), NOT
  a new resolver.
- **Facility tab / "payer board" (the old Data Flag #3 inverse view):** DE-SCOPED from this
  redesign → later phase. Superseded by the Change E hybrid; do NOT ship it as "preview."
- **Ratings cutoffs:** stay 50/30. Do NOT retune `rating.ts`.
- **Labels:** `warn` "Typical" → "Watch" (so the legend reads Strong / Watch / Weak);
  `explainRating` "limited data" → "thin sample". One-line, approved.
- **Client Name:** exact-name only for v1 (no prefix — too broad across PHI). Dominant-payer
  resolution WITH a visible "name may span multiple patients" note. Audited via a new
  `SEARCH_QUALIFY_NAME` action (field name only; raw name never logged/URL'd). Reuse the
  `blindIndex.ts` keyed-HMAC helpers — no new crypto, no `pg_trgm`, no ciphertext LIKE.
- **Month/Year:** 180d is DROPPED. Calendar-mode prior window for Δ = previous equivalent
  calendar period (previous month / prior year), NOT prior-year-same-month.
- **Change D LOC lens:** view-only for v1 (facilities + cases, client-side, inclusive
  `filterFacilitiesByLoc` semantics). KPIs stay book-wide with a caption. Not a server param yet.
- **Facility `ent` (BXR/Indigo) tag:** expose as a small non-PHI label per facility — this is a
  label, not entity grouping (grouping/splitting by entity stays banned). Skip only if it
  materially complicates the matview.
- **Change B audit volume:** confirmed acceptable — global persistent reveal raises audit-row
  count by design. Keep every scope's reveal audited.
- **"group #" in the ID-tab resolve copy:** DROP it — there is no resolve-by-group path and we
  are not adding one. Group # stays the cases-drill filter it already is.

**STILL OPEN — one input Alec owes:** the **"Our / All facilities" toggle** — what defines
"ours"? Default until told: a small static roster of Treat-operated facility keys ("Our"
filters to it, "All" = everything cross-tenant). If no roster is supplied, ship the toggle
**hidden, defaulting to "All"** — never fabricate ownership.

---

## PHASE 0 — TOKENS + MOTION (one place, both surfaces)

- Add to `design-system.md` + `tailwind.config.ts`: the `display: Fraunces` row (already used
  by the Qualify `<h1>` via `font-display` — document it), a 3-tier **elevation** scale
  (`shadow-ths` raised / `shadow-ths-lg` floating + a new subtle `shadow-ths-sm` for cards at
  rest), and confirm the `ths-reveal`/`ths-exit` motion tokens.
- Add utility classes the mockup relies on: staged `animate-ths-reveal` with capped
  per-item delay; a sparkline draw-in (`stroke-dashoffset`) that collapses under the existing
  `prefers-reduced-motion` reset.
- Consolidate the mobile surface off inline hex onto the shared tokens (CSS vars / a shared
  `qualify/tokens.ts`) so a color change is made once, not twice.
HOLD — show the token diff before applying.

## PHASE 1 — DESKTOP SHELL (overview-first, autosearch)

Rebuild `qualify-tab.tsx` layout to the mockup:
1. **Search-type tabs** (Member ID/Prefix · Employer · Client Name · Facility) above the bar;
   switching a tab changes placeholder + "TRY" examples. (Client Name is now a real path —
   see Change C.)
2. **Autosearch — remove the "Resolve payer" button entirely.** Resolve on a debounced input
   (~350–400ms, ≥3 chars) and on Enter. Reuse the server-side sniff (member-ID vs prefix); do
   not ask the client to declare the kind. Keep the live branch-hint chip.
3. **Window control = `30d / 60d / 90d / Month-Year`.** Month/Year reveals Month + Year
   selects. Map 30/60/90 to the existing trailing-N-days param; Month/Year is a new
   calendar-window shape — HOLD and confirm the query parameterization (it is NOT trailing-N).
4. **Remove the "Color layer" toggle.** Ship the heat tint on by default in the facilities
   panel.
5. **Facilities Heating Up** row (trending, `Our facilities` / `All facilities` toggle) and
   the **book-wide KPI tiles**. See data flags in Change/HOLD notes.
6. **Bottom half — resolved-payer subject band + `FacilityPanel` + `CasesTable`, with facility
   drilldown wired (Change E).** NOTE: "bottom half unchanged" would be inaccurate against the
   mockup — `renderFacList`/`renderCases` already wire facility-click → re-scoped cases, and the
   on-load hybrid replaces the placeholder `resolveByPayer('Aetna')`. Facility-scoped cases were
   previously deferred (`veris-data-notes.md`: "per-facility cases query, own gated task, frozen
   contract must not reopen") — the approved mockup has since decided it. Reconcile per Change E
   BEFORE Phase 1 starts: facility-scoped cases IS in scope, not deferred.
Keep every dollar element gated by DOM omission on `viewerHasAmountsCapability`.
HOLD before commit.

## PHASE 2 — MOBILE SHELL

Mirror Phase 1 in `app/components/qualify/m/*`: autosearch (no resolve button), the
`30/60/90/Month-Year` selector, a compact KPI strip + Heating-Up chips at rest, then the
existing swipe deck → detail → claim flow. Same tokens, same gates.
HOLD before commit.

---

## CHANGE A — DEFINE "n" IN THE UI

Everywhere the mockup shows `n=210`, "n" is the **facility's claim-line count backing the
rating** (`lineCount`). Do not ship a bare `n=`. Either render `n=210 claim lines` or show
`210 claims` with an `n = claim lines backing the rating` definition on first use (tooltip +
one-line legend). Apply to heating-up cards, KPI/context lines, and the facilities panel.
Update `RATING_LEGEND` / `CONFIDENCE_LEGEND` copy in `rating.ts` if that is where the legend
text lives, so both surfaces read identically.

## CHANGE B — GLOBAL, PERSISTENT PHI REVEAL FOR SUPER_ADMIN + ADMIN

Today reveal is per-patient and `resetReveal()` wipes it on every scope change (new search,
facility switch, window, payer). New behavior:
- For **super_admin and admin** sessions, add a single global **"Reveal identifiers"** toggle
  (session-scoped, in-memory only — never `localStorage`, per the existing rule). When ON, PHI
  is shown across the whole surface and **persists across scope changes** — a new search /
  facility switch / window change keeps it revealed instead of re-masking.
- Persistence is UI state only. **Every newly-loaded PHI row is still audited** on reveal —
  the global toggle changes when we re-reveal, not whether we audit. Each scope that surfaces
  new rows fires the same audited `revealQualifyRows` path (respect the batch cap; never log
  the identifiers).
- `admissions_seat` is unchanged: keep its existing per-patient audited reveal (and it still
  sees zero dollars). The global toggle renders only for super_admin/admin.
- The amounts gate stays orthogonal — reveal never exposes dollars to a non-`super_admin`.
Update `qualify-tab.tsx` + `cases-table.tsx` (desktop) and the mobile detail/claim sheets.
Wire-level + rendered-markup tests for both toggle states.
HOLD — confirm the audit-volume implication of auto-revealing on every scope change is
acceptable before building (it increases audit rows; that is the intended tradeoff, but say
so out loud).

## CHANGE C — CLIENT NAME SEARCH IS NOT BLOCKED (internal tool)

This **supersedes** the `qualify-build-series.md` Prompt-2 ruling ("no name search, no
substring path"). Alec has ruled: Qualify is an internal tool; enable Client Name as a real
resolution path.
- The Client Name tab is fully functional (no PHI-lock note). Typing a client name resolves to
  that client's line / their payer, then the normal facility + claims drill.
- Still audited, still safe: the raw name is **never logged, never put in a URL or summary
  object**; the lookup is parameterized. Because patient/client PHI is libsodium-encrypted, you
  cannot `LIKE` the ciphertext — reuse the existing **blind-index** pattern (the member-ID
  exact path already does this) with a normalized name key (exact + prefix), or `pg_trgm` on an
  approved normalized-name index if one exists. **HOLD** and confirm which mechanism before
  implementing — this is the one real backend design decision here.
- Add `client_name` as a `matchedOn` value in the contract and a resolution branch in
  `core.ts` / `server.ts` / `qualifyQuery.ts`, cross-tenant like every other Qualify read.

## CHANGE D — IP / OP / BOTH LEVEL-OF-CARE FILTER ON THE MAIN SEARCH BAR

Promote the level-of-care filter to a **top-level lens in the search bar**, next to the
window control (a persistent segmented `IP · OP · Both`, default Both/none). It already exists
as an in-panel chip row in `qualify-tab.tsx` / `qualify-mobile-app.tsx` via
`filterFacilitiesByLoc` (`groupClaims.ts`) over each facility's `careSetting` — this change
lifts it out of the panel to the bar so it scopes the whole surface consistently, and removes
the now-redundant in-panel copy.
- Apply it consistently across **Facilities Heating Up, the facility ranking, and the cases
  drill** — one lens, everywhere, not three separate filters.
- Facilities + cases can stay a **client-side view filter** over already-fetched data (reuse
  `filterFacilitiesByLoc`; `careSetting` is already on the facility rows). It resets nothing
  else and does not re-resolve the payer.
- **HOLD** on one question: should the lens also re-aggregate the **book-wide KPIs and the
  Heating-Up trend/deltas** (which would make it a server query param, not a view filter), or
  is view-only scoping of facilities/cases enough for v1? Default recommendation: view-only for
  v1; KPIs stay book-wide with a caption noting they are not LOC-scoped. Confirm before wiring
  it into the aggregates.

## CHANGE E — FACILITY DRILLDOWN WIRING

Payer-wide vs. facility-scoped state:
- **Payer-wide** (default on a search-driven resolve): facilities panel = full list, cases
  panel = payer-wide most-recent, as today.
- **Facility-scoped** (on facility-row click, or via Heating-Up — see below): cases panel
  narrows to that facility. The selected row is shown pinned/summarized where the full list was
  (name, rating, "change" link) — do NOT fully collapse the panel to nothing.
- **Contract:** add optional `facilityId` to `getQualifySnapshot`. When present, the cases query
  re-runs scoped to that facility **server-side**. Do NOT client-filter the existing global
  top-15 cases list — a low-volume facility's recent claims can be crowded out of a payer-wide
  top-15, which would silently under-report. This is a reviewed, explicit contract extension,
  not the kind of silent change the frozen-contract rule guards against.
- **Window change** (30/60/90/Month-Year) resets facility scope back to payer-wide — clear
  `facilityId` in the same request, not two round trips.
- **Clear-scope affordance** (doesn't exist in mockup or prod): build a visible "× All
  facilities" pill next to the resolved-payer subject band, same visual weight as the payer
  chip. 44×44px min hit target, visible focus ring, `aria-label="Clear facility filter, show
  all facilities"`.
- **Case row → claim detail** stays inside Qualify. Mobile already has `claim-detail-sheet.tsx`;
  desktop `cases-table.tsx` has none. **HOLD:** check whether Billing Audit's existing
  `ClaimDetailSheet` can be adapted before building new — confirm reuse vs. new.

**Facilities Heating Up — RESOLVED (replaces the two prior open questions; do not ask CC to
guess).** The module is facility-shaped (name, city, rating, trend — no payer field), not the
old payer-centric Movers. **DECISION: hybrid.** On card click, resolve the facility's dominant
payer (existing machinery) AND immediately apply the Change-E facility scope to the clicked
facility — so the first thing rendered is that specific facility's narrowed cases, not the
payer's full unrelated facility list. Ships now, no dependency on the de-scoped payer-board,
and doesn't misrepresent what the click did. The same hybrid drives "land on the top mover on
load": auto-resolve the top mover's dominant payer AND auto-apply facility scope to it — NOT
the placeholder `resolveByPayer('Aetna')`. **Strip that hardcoded call from both the desktop
`hcard` and mobile `mchip` handlers — it's demo scaffolding that ignores which card was
clicked.** True facility-centric "payer board" mode stays a later phase; this hybrid is the
right v1 answer on its own, not a placeholder for it.
Optional (not a blocking HOLD): a 10-minute click-through of the hybrid with Ravie (real daily
admissions user) before Phase 1 ships, if convenient.

## CHANGE F — SHAREABLE / PERSISTENT DRILLDOWN STATE (URL)

Payer + facility + window + loc should survive refresh and be shareable.
**HARD CONSTRAINT: PHI never in URLs** (existing non-negotiable — `member_id` and `client_name`
are both named PHI; the raw search query is one of those two today, so it must NEVER be a URL
param).
- Encode ONLY resolved, non-PHI fields:
  `?payer={resolved.payerName}&facility={facilityId}&window={…}&loc={…}`. Never `matchedValue`
  when `matchedOn` is `member_id` or `client_name`.
- Whether a bare 3-letter prefix (`matchedOn: 'prefix'`) is URL-safe is **Alec's call** — do not
  assume. (My lean: a 3-letter alpha prefix selects a payer, not a patient, so likely safe —
  but confirm.)
- On load-from-URL, re-resolve via `resolveByPayer(payerName)` (already exists; bypasses
  ID/prefix/name matching) — never replay a stored raw query.
- Debounce URL writes SEPARATELY from the 380ms autosearch debounce: commit to the URL only on
  a resolved-state change, never on keystroke. Use `router.replace`, not `push`.
- **HOLD:** confirm this design before building — it changes "PHI never in URLs" enforcement
  from "trivially true" to "requires an explicit allowlist."

## CHANGE G — MOBILE DRILLDOWN PARITY

NOT a literal bottom tab bar (Qualify-mobile is a single-purpose install — nothing to switch
to). Instead: a persistent **breadcrumb strip** (`Payer > Facility > Claim`, whichever levels
are live) pinned above the deck/sheet, each crumb tappable to jump directly to that level.
Reuse the existing `.back` chevron pattern in `msheet`/`shead`; add jump-to-any-level instead
of one-screen-back-at-a-time.

---

## DATA / CONTRACT ADDITIONS (decided in RULINGS — build, each behind its own migration HOLD)

Nothing ships with invented numbers; until an aggregate lands, its tile/sparkline shows a
"preview — pending data" state.
1. **Book-wide KPI aggregate** (`buildBookKpisQuery`): `sum(charge)`, `sum(reliable allowed
   ex-e2)`, `sum(insurance_payments)` → the three percentages ONLY (dollars server-side, never
   returned). In-plane on the Qualify rollup — no external collections join.
2. **Per-facility trend aggregate** (`buildFacilityTrendQuery`): weekly rating buckets over the
   window + prior-equal-window Δ. Powers sparklines + the Heating-Up sort.
3. **`facilityId` cases scoping** (Change E) — the server-side re-scope, not a client filter.
4. **Employer tab** → existing `QualifyMarket.employers` narrow. **Facility "payer board"** →
   de-scoped (later phase, per Change E).

---

## RATINGS VOCABULARY + CUTOFFS

- Labels (approved): `RATING_LEGEND.labels` reads **Strong / Watch / Weak** — the only change
  is `warn` "Typical" → "Watch". `explainRating` "limited data" → "thin sample".
- Cutoffs stay at the shipping **50 / 30** (`RATING_OK_MIN` / `RATING_WARN_MIN`) — do NOT
  retune `rating.ts`. The mockup's cleaner numbers were illustrative.

## DEFINITION OF DONE

- Desktop + mobile match the mockup's structure/feel; Alec can hold them side by side.
- Autosearch works; no resolve button; `30/60/90/Month-Year` functions.
- "n" is defined in-UI everywhere it appears.
- IP/OP/Both lens lives on the search bar, view-only scoping of facilities + cases, and the
  redundant in-panel chip row is removed.
- Facility drilldown (Change E): row-click re-scopes cases server-side via `facilityId`;
  selected facility pinned/summarized (not collapsed); window change clears scope in one
  request; visible "× All facilities" clear pill (44px hit target, focus ring, aria-label);
  Heating-Up + on-load use the hybrid; the `resolveByPayer('Aetna')` demo call is gone from
  both surfaces.
- URL state (Change F): payer + facility + window + loc survive refresh / are shareable via
  `router.replace`; only non-PHI resolved fields encoded; never `member_id` / `client_name`;
  load re-resolves via `resolveByPayer(payerName)`.
- Mobile (Change G): tappable `Payer > Facility > Claim` breadcrumb strip above the deck/sheet.
- Global persistent reveal works for super_admin/admin, still audited per scope; admissions_seat
  unchanged; amounts gate intact (wire-level + rendered-markup tests green both states).
- Client Name resolves via the confirmed audited/blind-index path; no raw name in any log
  (grep the test logs).
- Cross-tenant test green (rows from both BXR + Indigo). Typecheck clean. No secret in any
  client bundle.
- `qualify-render.test.tsx`, `qualify-mobile-render.test.tsx`, `qualifyColors.test.ts` updated
  for the new markup/labels.

## HOLD GATES

HOLD before, in order:
1. Phase 0 token diff.
2. Every migration — client-name blind-index (mirror 0036/0037/0049 + rebuild the 0059
   matview), the KPI + trend aggregates — DDL + rollback shown.
3. The `facilityId` contract extension (Change E) — schema diff shown.
4. Change F's URL-encoding allowlist — explicit non-PHI field list shown, plus the
   prefix-in-URL safety ruling.
5. The desktop `ClaimDetailSheet` reuse-vs-new decision (Change E).
6. Every commit/push. Cross-tenant + both typechecks + `cd app && npm run build` before any push.

The Heating-Up click-behavior and the Month/Year parameterization questions are RESOLVED
(Change E hybrid; RULINGS · Month/Year) — do not re-ask them.

FIRST OUTPUT: most of your first-output §5 questions are now answered in RULINGS — do NOT
re-ask those. Confirm you've re-read the mockup + this file; propose (a) the client-name
blind-index migration + `buildResolveByNameQuery`, (b) the `buildBookKpisQuery` +
`buildFacilityTrendQuery` shapes, (c) the `facilityId` schema diff, (d) the Change F URL
allowlist; note anything that still conflicts; then a phase-by-phase build plan. STOP for
Alec's go. The only product input still owed is the "Our / All facilities" roster (RULINGS).
