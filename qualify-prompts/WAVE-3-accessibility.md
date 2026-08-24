ultracode

# Qualify — Wave 3: accessibility (WCAG 2.2 Level A / AA)

Six Critical findings, then fourteen Major. **This is a compliance PR** — the app is an internal PHI-aware tool with an `admissions_seat` persona for whom `/qualify` is the *only* screen, so a keyboard-inaccessible control is not a papercut, it is a person who cannot do their job.

A WCAG 2.2 audit produced these with file:line evidence and computed contrast ratios. **Every ratio below was calculated with the relative-luminance formula including alpha compositing over the real parent background.** Do not re-derive them; verify by measurement if you doubt one, and tell me if I'm wrong.

**26 scanner findings were checked and dismissed as false positives — §6. Do not "fix" them.**

---

## 0. GROUND RULES — read the convention files FIRST

Read: `CLAUDE.md` → `.claude/rules/qualify.md` → `.claude/rules/nextjs-app.md`. Those outrank this prompt; conflict → surface and stop.

Relevant invariants:

- **PHI never** reaches logs, LLM prompts, a URL, browser storage, or an accessible name you build from row data. **Adding an `aria-label` is adding a data path — check what's in it.**
- **Tests stay hermetic** — `node:test` only, no new test-runner deps. jsdom pointer-event infrastructure does not exist in this repo yet; if a fix needs it, say so rather than adding a runner.
- **Never add a `Co-Authored-By` trailer.**
- **Gate outward-facing actions** — HOLD before committing, pushing, or deploying.
- **PRs open against `main`** — `gh pr create --base main`. (⚠ `staging` was DELETED 2026-08-14 (ruled poor dev practice) — branch off `main`, PR to `main`.)

**Verification gate — all five, green, before any commit:**

```bash
npm test                    # >=1439 pass / 0 fail
npm run typecheck
cd app && npm test          # >=831 pass / 0 fail
cd app && npm run typecheck
cd app && npm run build
```

Counts are floors. Fewer means tests were lost.

---

## 1. THE ONE STRUCTURAL RULE FOR THIS WAVE

**Do the contrast work ONCE, at the token layer.** Every failing pair below resolves in three files:

- `app/components/qualify/tokens.ts` — `QUALIFY_PALETTE`, `RATING_HEX`, `IQ_BAND_HEX`, `IQ_BAND_WASH`, `TAPE_PALETTE`
- `app/components/qualify/m/colors.ts` — `STYLES`, `IQ_STYLES`
- `app/app/globals.css:166-227` — `--q-c` / `--q-wash` and the `.q-pct` / `.q-pctcell` rules

**Do not patch call sites individually.** A per-site fix on a token-level problem guarantees drift, and this palette already has a ⚠ warning block in `tokens.ts:76-84` that a previous drift produced.

After changing tokens, **re-measure every pair** and report the new table. The full current table is in §5 so you can diff against it — including the pairs that **pass**, which must not regress.

---

## 2. ORCHESTRATION

```
phase('Tokens')   → ONE agent, serialized. Fix tokens.ts + m/colors.ts + globals.css.
                    Return the full re-measured pair table. Everything else waits on this.
phase('Confirm')  → one agent per non-contrast finding: confirm on HEAD, return the
                    change surface. {stillPresent:false} with evidence is valid.
phase('Fix')      → pipeline. Group by file to avoid worktree conflicts:
                      • m/*.tsx sheets + swipe-row + facility-list + market-filter → one agent
                      • v3/resolution-flow.tsx (4,856 lines) → ONE agent, serialized
                      • shell/* → one agent
                      • desktop leaf components → one agent
phase('Verify')   → per fix, an independent agent asked to REFUTE:
                    "does this accessible name leak PHI? does this focus change break
                     the existing useDialog contract? does this contrast change regress
                     a pair that currently PASSES?"
phase('Gate')     → five commands, exact counts.
```

**Two fixes need a real browser, not static reasoning** — see §4 "verify in browser". Do not assert a target-size pass or fail from Tailwind classes alone; inherited `line-height` decides it.

---

## 3. CRITICAL — six findings

### C-1 · Mobile ranked-list pagination is swipe-only
**`m/facility-list.tsx:113-131, 142-157, 189-193`** · SC **2.1.1 Keyboard (A)**, **2.5.1 Pointer Gestures (A)**, **2.5.7 Dragging Movements (AA)**

```tsx
const goingRight = d.dx > 0 || (d.dx === 0 && v > 0);
if (goingRight) onPagePrev(); else onPageNext();
...
Swipe left or right to page · tap a card to open
```

`onPageNext`/`onPagePrev` are invoked **only** from `onUp()` inside the pointer-drag pipeline. There is no Next/Prev button, no `onKeyDown`. The page-indicator dots (`:177-186`) are `aria-hidden` spans, not buttons.

**Blocks:** keyboard-only, switch, screen-reader, tremor and limited-dexterity users reach page 1 and nothing else. **Everything past facility #5 is unreachable.**

**Outcome:** a single-pointer, keyboard-operable path to every page. Keep the swipe — it is good on touch — but it cannot be the only path.

### C-2 · Employer type-ahead options are unreachable by keyboard
**`m/market-filter.tsx:119-203`** · SC **2.1.1 (A)**, **4.1.2 Name/Role/Value (A)**, **4.1.3 Status Messages (AA)**

```tsx
onBlur={() => setTimeout(() => setOpen(false), 150)}
...
{open && q.length >= 3 && (<div style={{position:'absolute',...}}>
  <button onMouseDown={(e) => e.preventDefault()} ... >
```

Tabbing off the input fires `onBlur`; 150 ms later `setOpen(false)` unmounts the option button **that just received focus**, dumping focus to `<body>`. The `onMouseDown` preventDefault guard is **pointer-only**.

The control is also a bare `<input>` + `<div>`: no `role="combobox"`, no `aria-expanded`, `aria-controls`, `aria-autocomplete`; no `role="listbox"`/`option`; no arrow-key handling; no live region announcing "N matches".

**Blocks:** keyboard-only and screen-reader users **cannot apply an employer filter at all**, and are never told a result list appeared.

**Outcome:** build it as a WAI-ARIA APG combobox. **PHI note:** the option labels are employer names — check what reaches the live-region announcement, and see Wave 1 P0-4 on employer handling.

### C-3 · All three mobile bottom sheets are modals with no dialog semantics
**`m/detail-sheet.tsx:125-129`, `m/trend-sheet.tsx:48-52`, `m/claim-detail-sheet.tsx:169-173`** · SC **1.3.1 (A)**, **2.1.1 (A)**, **2.4.3 (A)**, **4.1.2 (A)**

```tsx
<div onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
     style={{ position:'fixed', inset:0, zIndex:50, background:'rgba(27,43,42,0.45)', ... }}>
  <div style={{ width:'100%', maxHeight:'85vh', ... }}>
```

**None of the three imports `useDialog`.** Missing on all three: `role="dialog"`, `aria-modal="true"`, an accessible name (the titles at `detail-sheet.tsx:131`, `trend-sheet.tsx:56`, `claim-detail-sheet.tsx:176` are plain `<div>`s), initial focus, focus trap, focus restore on close, Escape-to-close, and `inert`/`aria-hidden` on the background.

`ClaimDetailSheet` (z-60) stacks on top of `DetailSheet` (z-50) with **both fully in the tab order**.

**Blocks:** screen-reader users are never told a sheet opened and keep browsing the page behind it; keyboard users tab straight out into the obscured content and cannot press Escape.

**Outcome:** route all three through the **existing `useDialog`** rather than writing new focus code. `useDialog.ts:60` already implements opener-capture and restore correctly — reuse it.

### C-4 · Policy-tape rating numbers use light-surface band hexes on the dark tape
**`policy-tape.tsx:161-163`** · SC **1.4.3 Contrast (Minimum) (AA)**

```tsx
<span className="font-mono text-[15px] font-semibold" style={{ color: IQ_BAND_HEX[band] }}>
  {p.ratingNow}
</span>
```

15 px / 600 is **normal text** → 4.5:1 required. Measured against `bg-teal900 #0E3A3A`:

| band | hex | ratio |
|---|---|---|
| 65 | `#2E8B6F` | **2.99** |
| 50 | `#1C8B82` | **3.01** |
| 30 | `#C9881E` | **4.17** |
| 15 | `#E2674F` | **3.73** |
| 0 | `#C0453B` | **2.47** |

**This is the exact mistake `tokens.ts:76-84` warns against in a ⚠ block** ("THESE ARE NOT RATING_HEX AND MUST NOT BE SWAPPED FOR IT… ~1.9:1 — invisible"). `IQ_BAND_HEX['65']` **is** `RATING_HEX.ok`, byte-identical, and it is painted here. Only `TAPE_PALETTE.up/down` were ever measured against the inverse surface, and they are used only by `DeltaText`.

**Blocks:** low-vision users. The rating is the most load-bearing number on the strip and the least legible thing on it.

**Outcome:** mint **inverse-surface band colours** in `TAPE_PALETTE` and use those on the tape. Do not lighten `IQ_BAND_HEX` — it would regress the light-surface pairs.

### C-5 · `.q-pct` / `.q-pctcell` paint bucket hexes as 12.5 px body text
**`globals.css:210-227`** consumed at **`cases-table.tsx:210, 312`** · SC **1.4.3 (AA)**

```css
.q-pct { color: var(--q-c); }
.q-pctcell { color: var(--q-c); }
.q-heat .q-pctcell { background: var(--q-wash); }
```

The `% allowed` cell is `text-[12.5px] font-semibold` — normal text.

| bucket | fg | on `bg-card` white | on its `--q-wash` (heat on) |
|---|---|---|---|
| ok | `#2E8B6F` | **4.17** | `#E6F2EC` → **3.63** |
| warn | `#C9881E` | **2.99** | `#FBF1DE` → **2.67** |
| danger | `#C0453B` | 5.05 ✓ | `#FBE7E4` → **4.25** |
| neutral | `#6B7B79` | **4.44** | — |
| band50 | `#1C8B82` | **4.15** | `#EAF4F2` → **3.70** |
| band15 | `#E2674F` | **3.34** | `#FCEDE8` → **2.93** |

Amber at **2.67** is the worst — **and amber is the estimate/reversal tell**, the one a biller most needs to catch.

**⚠ Do not regress `facility-panel.tsx:412`**, which renders the same `q-pct` class at 38–52 px. That is large text at 3:1 and it currently **passes**.

### C-6 · Focus indicator removed with no replacement on both mobile text inputs
**`m/qualify-mobile-app.tsx:673`**, **`m/market-filter.tsx:130-140`** · SC **2.4.7 Focus Visible (AA)**

Both set inline `outline: 'none'` with no `:focus`/`:focus-visible` rule. Both files style purely inline, and **there is no global focus fallback in `globals.css`** — verified: the only `focus` occurrence in that file is a comment at line 552.

**Blocks:** keyboard users. The **primary search field of the mobile app** gives zero indication it is focused.

**Outcome:** add the **global `:focus-visible` fallback** to `globals.css` while you are there. That one change also de-risks M8 below and every future inline-styled control.

---

## 4. MAJOR — fourteen findings

- **M1 · Infinite marquees with no pause/stop/hide mechanism** — `useMarquee.ts:139-192`, `policy-tape.tsx:225-231`, `heating-ticker.tsx:276-282`. The rAF loop runs at `SPEED_PX_PER_SEC = 32` indefinitely; it pauses only on `pointerover`/`focusin`/recent gesture. `prefers-reduced-motion` **is** honoured (`useMarquee.ts:142`) but it is a UA setting, **not a mechanism in the content**, and it is read **once at effect setup with no `change` listener**. Worse: when `onExplain` is undefined the tape's items render as `<span>` (`policy-tape.tsx:200`), so the `<ul>` scroll container has **no focusable descendants** — Chrome does not make scroll containers keyboard-focusable, so a keyboard user can neither pause the strip nor scroll it, and overflowing content is unreachable. **Two of these are stacked above the answer.** Add a real pause control and the `change` listener. — *SC 2.2.2 (A), 2.1.1 (A)*
- **M2 · The mobile PWA has no `<main>`, no `<h1>`, and no heading element at all** — grep across `m/*` returns **zero** `<h1>`–`<h6>` and **zero** `<main>`; `m/layout.tsx` adds no landmark either. The page title (`m/qualify-mobile-app.tsx:619-624`), all three sheet titles, "Facility Momentum" (`m/heating-up.tsx:38`) and "Funding" (`m/market-filter.tsx:89`) are styled `<div>`/`<span>`. The only landmark on the route is a breadcrumb `<nav>` at `:786`. SR users lose **both** orientation mechanisms on the densest surface in the app. — *SC 1.3.1 (A), 2.4.1 (A)*
- **M3 · `SwipeRow` nests a real `<button>` inside `role="button"`** — `m/swipe-row.tsx:71-77` and `:128-137`. `role="button"` carries a presentational-children requirement; nested interactive content is invalid ARIA. JAWS/NVDA browse mode and the VoiceOver rotor commonly flatten the container and **drop the nested "why this rating" control** — the only path to the coverage/reversal explanation on the mobile card. The container's `onKeyDown` also swallows Space/Enter bubbling from inside. **Prefer a native `<a>`/`<button>` container over `role="button"`.** — *SC 4.1.2 (A)*
- **M4 · Rating colours fail 4.5:1 as small text across mobile** — `m/swipe-row.tsx:123-126` (verdict label, 12 px: ok 4.17, warn **2.99**, neutral 4.44, band50 4.15, band15 **3.34** on white) · `m/detail-sheet.tsx:190-192` (11 px chip: warn **2.82/2.67**) · `m/detail-sheet.tsx:267` (11 px: ok **3.94**, warn **2.82**) · `m/claim-detail-sheet.tsx:197` (13 px/600: ok **3.94**, warn **2.82**) · `m/trend-sheet.tsx:96` (13 px/700: ok 4.17, warn **2.99**) · `m/policy-line.tsx:53` INN **3.68**, `:55` OON **2.67**, `:60` VOB-stale **4.35**. **The rating number at 20 px/700 qualifies as large text and passes — the verdict word beneath it does not, and the verdict word is what a rep reads.** — *SC 1.4.3 (AA)*
- **M5 · Mobile KPI tile numbers at 2.67:1** — `m/qualify-mobile-app.tsx:851-856`: `#C9881E` on `#FBF1DE` = **2.67**, failing even the 3:1 large-text bar. The `allowed/billed` tile (`#2E8B6F` on `#E6F2EC` = 3.63) squeaks past large-text only. Two of three headline percentages are effectively unreadable. — *SC 1.4.3 (AA)*
- **M6 · Registry "History" table has no header cells** — `registry-client.tsx:337-355`: five data columns (payer, facility, codes, lifecycle, effective range), no `<thead>`, no `<th>`, no `<caption>`, no `aria-label`. A table-navigation pass announces cell content with no column identity. (The *Current decisions* table at `:281-292` **does** have `<th>` — see FP-6, don't touch it.) — *SC 1.3.1 (A)*
- **M7 · Coverage micro-bar encodes information as colour only, below non-text contrast** — `m/swipe-row.tsx:118-127`. Confirmed vs estimate is distinguishable by hue alone: `#2e8b6f` vs track `#E4E9E6` = 3.39 ✓, `#c9881e` vs track = **2.43**, green-vs-amber boundary = **1.39**. It is `aria-hidden` with **no text equivalent on the card** — unlike `trend-sheet.tsx:70-77`, where the same bar sits under explicit "Confirmed claims / Estimates (excluded)" counts. Copy that pattern. — *SC 1.4.1 (A), 1.4.11 (AA)*
- **M8 · `ring-teal500/40` is a 1.67:1 focus ring** — 10 sites: `heating-ticker.tsx:197`, `facility-panel.tsx:329, 472`, `qualify-tab.tsx:1065, 1087`, `ticker-explainer.tsx:135`, `v3/resolution-flow.tsx:1386`, +3. `rgba(28,139,130,0.40)` composited on white = **1.67**, with `focus-visible:outline-none` and no offset or second ring. (The four sites using `/25` **also** set `focus:border-teal500` at 4.15 and are borderline-acceptable — lower priority.) The C-6 global fallback helps here; make the ring itself meet 3:1 regardless. — *SC 2.4.7 (AA)*
- **M9 · Ticker explainer never returns focus and re-steals it on every prop change** — `ticker-explainer.tsx:106-115`: no opener capture, no restore in cleanup, so closing drops focus to `<body>` — **the exact failure `useDialog.ts:60` was written to prevent**. And `onClose` is an inline arrow at the call site, so its identity changes every parent render, the effect re-fires, and focus is yanked back to Close **mid-read**. Route it through `useDialog`. — *SC 2.4.3 (A)*
- **M10 · Two sticky headers with no `scroll-margin-top`** — `v3/resolution-flow.tsx:863-866` (sticky stage `<h2>` + pinned filter over a long tile grid) and `m/qualify-mobile-app.tsx:620` (~180 px tall with the range menu open). Grep for `scroll-mt`/`scroll-margin`/`scrollMarginTop` across the entire qualify tree returns **zero hits**. Tabbing to a control just below the fold parks it underneath the sticky block. — *SC 2.4.11 Focus Not Obscured (AA, WCAG 2.2)*
- **M11 · `role="menu"` containing non-menuitem controls** — `window-control.tsx:259-327`: two `<select>`s and two static `<div>` labels inside a `role="menu"` whose owned children must be `menuitem*`; AT in application mode may not expose them. Opening does not move focus into the menu, and Escape (`:179-181`) closes without returning focus to the trigger. **The mobile twin is the inverse defect**: `m/qualify-mobile-app.tsx:698-702` sets `aria-haspopup="menu"` + `aria-expanded` but the popup at `:719` is a plain `<div>` with **no role at all**, and no Escape or click-outside handler. — *SC 4.1.2 (A)*
- **M12 · Modal overlays don't neutralise the background** — `vob-modal.tsx:26-42` correctly sets `role="dialog" aria-modal="true" aria-labelledby` and traps, but nothing outside is `inert`/`aria-hidden`. `cohort-sheet.tsx:85-91` deliberately runs `{ trap: false }` while rendering as a `fixed inset-y-0 right-0 z-50` overlay — visually modal, keyboard-escapable behind. **Separately: `vob-modal.tsx:70-72` "Start VOB" is a focusable, enabled, primary-styled `<button>` with no handler** (it ships a visible `CTA inert · TODO` badge). A control that does nothing on activation is a 4.1.2 value failure regardless of product intent — either wire it or make it `disabled` with the reason as its accessible description. Wiring it is a **Wave 4** product decision; making it honest is this wave. — *SC 4.1.2 (A), 2.4.3 (A)*
- **M13 · Employer chip remove button is ~14 × 9 CSS px** — `m/market-filter.tsx:228-235`: `lineHeight: 1` at `fontSize: 14` with zero padding pins the content box to 14 px tall and the `×` advance to ~9 px. No spacing exception applies — the chip text is adjacent. — *SC 2.5.8 Target Size Minimum (AA, WCAG 2.2)*
- **M14 · Low-contrast chip and clause text on the desktop board** — `policy-tape.tsx:160` `text-white/45` on teal900 = **3.81** (this is the "IP · Sacramento, CA" clause the file's own header calls a **required disambiguator**) · `policy-strip.tsx:75` `text-status-warn/80` on white ≈ **2.4** · `m/qualify-mobile-app.tsx:894-903` inactive LOC chip **4.32** · `m/market-filter.tsx:89-91, 100-109` "Funding" label + inactive pills **4.32**. (`m/area-chips.tsx:88-98` at 7.07 **passes** — listed so it isn't "fixed".) — *SC 1.4.3 (AA)*

### Minor / advisory — fix opportunistically, do not expand the PR for them

`aria-label` on non-interactive role-less elements is ignored (`m/facility-list.tsx:173`, `v3/resolution-flow.tsx:1710`; `policy-tape.tsx:197-199` documents the rule correctly) · mobile page changes unannounced, no live region and no focus move (`m/facility-list.tsx:172-188`, SC 4.1.3) · two controls expose `aria-expanded` for one disclosure, neither with `aria-controls` (`facility-panel.tsx:328, 470`) · no `aria-current` on the breadcrumb (`m/qualify-mobile-app.tsx:806-810`) · **no skip link anywhere** — desktop is covered by landmarks (ARIA11) but this is a **real 2.4.1 failure on `/qualify/m`** because there is no `<main>` (M2) · fixed pixel heights on text containers break SC 1.4.12 text spacing (`m/swipe-row.tsx:79` `height:108`, `m/detail-sheet.tsx:181`, `m/area-chips.tsx:91`, `m/qualify-mobile-app.tsx:673`) · `focus:outline-none` on programmatically-focused containers (`vob-modal.tsx:40`, `cohort-sheet.tsx:90`, `v3/resolution-flow.tsx:850-855`) — not a strict 2.4.7 failure since these aren't tab stops, but it is the **only** cue to a sighted keyboard user that the stage changed · `search-trace.tsx:22-26, 45-47` tone carried by an `aria-hidden` glyph plus colour (low impact, the sentence self-describes).

**Verify in a real browser, do not assert statically:** target sizes at `m/sw-register.tsx:110` ("Got it", `background:none, border:none`, no padding at 12 px) and at `shell/recent-searches.tsx:55-61, 90-99`, `shell/lane-progress.tsx:272`, `v3/resolution-flow-client.tsx:1400, 1409` (`px-2 py-0.5` at 10–11 px). Whether these clear 24 px depends on inherited `line-height` (Tailwind preflight sets `button { line-height: inherit }`). **Measure or report unknown — do not guess either way.**

---

## 5. THE FILE'S OWN RULES ARE ALREADY BROKEN — decide which way

`v3/resolution-flow.tsx:20-21` declares, in its own header:

> "ONE `aria-live="polite"` region" · "No meaning-bearing text below 12px"

In shell mode the answer stage carries **four** live regions plus up to six `role="status"` nodes (which are live regions): the sr-only sentence (`:4718`), `LaneFeed` (`lane-progress.tsx:299`), `WatchersPanel` (`watchers-panel.tsx:62`), the AI panel (`qualify-ai-panel.tsx:366`), and the banners at `:3413, :3424, :3436, :3842, :4208, :4276`.

And there are **38 sub-12px meaning-bearing classes across `shell/*`** — worst: the watcher failure notice at 10 px mono (`watchers-panel.tsx:64`), the lock strip at 10.5 px (`lane-rail.tsx:84`), the composer's compliance line at 9.5 px (`composer.tsx:134`), recent-search metadata at 10 px (`recent-searches.tsx:85`).

**Either the rule holds or the header changes. Pick one and make the code and the comment agree.** A stated invariant the code violates is worse than no invariant — it tells the next reader the state is impossible. Bring me your recommendation; the live-region count is the part that actually degrades the SR experience, the font sizes are mostly a zoom-recoverable annoyance.

### Full contrast reference — current state, for diffing after the token change

**On `surface #FFFFFF`:** ink900 14.73 ✓ · ink600 7.07 ✓ · ink400 `#63756E` 4.88 ✓ · teal900 12.46 ✓ · teal700 7.56 ✓ · info `#2D7393` 5.27 ✓ · danger `#C0453B` 5.05 ✓ · **neutral `#6B7B79` 4.44** · **band50/teal500 `#1C8B82` 4.15** · **ok `#2E8B6F` 4.17** · **band15 `#E2674F` 3.34** · **warn `#C9881E` 2.99** · teal200 1.50 (border only) · line 1.23 (border only).

**On `ground #FBF8F4`:** ink400 4.61 ✓ · **ok 3.94** · **warn 2.82** · danger 4.77 ✓.

**On `teal900 #0E3A3A`:** white 12.46 ✓ · teal200 8.31 ✓ · `TAPE_PALETTE.up #46C4B8` 5.84 ✓ · `TAPE_PALETTE.down #F0917C` 5.37 ✓ · white/60 5.53 ✓ · `FLAT_HEX #FFFFFF8A` 4.81 ✓ · **white/45 3.81** · **IQ30 4.17** · **IQ15 3.73** · **IQ50 3.01** · **IQ65 2.99** · **IQ0 2.47**.

**Bucket on its own `.q-heat` wash:** **ok 3.63** · **warn 2.67** · **danger 4.25** · **band50 3.70** · **band15 2.93**.

**Mobile tints (`m/colors.ts`):** **ok/`#EAF3EE` 3.68** · **warn/`#FBF1E0` 2.67** · **danger/`#FBEAEA` 4.35** · **neutral/`#EFEDE7` 3.79**. **All four mobile bucket styles fail 4.5:1 against their own tint.**

**Passing pairs that must NOT be regressed:** `TAPE_PALETTE.up/down` on `surfaceInverse` (5.84 / 5.37) — the only movement colours legal on the tape. `ink400 #63756E` holds 4.88 on white and 4.61 on ground but **drops to 4.11–4.36 on every wash and tint** — it is at the edge, not comfortably inside it, so treat any new `ink400`-on-wash usage as a fail.

---

## 6. FALSE POSITIVES — checked and dismissed. DO NOT "FIX" THESE.

| # | Hit | Why it is not a violation |
|---|---|---|
| FP-1 | `registry-client.tsx:196, 200, 204, 208, 217, 221, 229, 233, 237, 245, 249` — "input/select/textarea with no accessible name" | Every one is wrapped in an **implicit label**: `<label className="text-xs …">Payer family*<input …/></label>` (`:194-197`), same shape through `:250`. Implicit association is valid HTML and produces a correct accessible name. **Do not add redundant `aria-label`s.** |
| FP-2 | `qualify-ai-panel.tsx:297` — "`<select>` with no accessible name" | Line 297 is **inside a comment**. There is no `<select>` element in that file at all. |
| FP-3 | `shell/composer.tsx:~65` — "`<select>` with no accessible name" | `<select id="qualify-composer-template">` at `:102` is named by `<label htmlFor="qualify-composer-template">Ask</label>` at `:98-100`. Line 65 is also a comment. |
| FP-4 | `slot-chip.tsx:~107` — "`<select>` with no accessible name" | `<select aria-label={SLOT_LABELS[segment.slot]}>` at `:100`. Named. |
| FP-5 | `cases-table.tsx:379` — "`<table>` missing caption/aria-label" | Full `<thead>`/`<th>` row at `:380-392`, preceded by `<h2>Recent Claims</h2>` at `:343`. WCAG does not require `<caption>`; 1.3.1 is satisfied by header cells. Best-practice improvement, not a failure. |
| FP-6 | `registry-client.tsx:281` — same | `<thead>` + nine `<th>` at `:282-293`, preceded by `<h2>Current decisions</h2>` at `:271`. (The **other** table at `:337` is a genuine failure — that's M6.) |
| FP-7 | `v3/resolution-flow.tsx:4668` — "duplicate `<h1>`" | Exactly **one** `<h1>` on the v3 path. `resolution-flow-client.tsx:1418` carries an explicit comment confirming it renders none. The other `<h1>`s are on mutually exclusive routes: `qualify-tab.tsx:960` (v2, behind `QUALIFY_V3_FLOW=off`), `qualify-maintenance-notice.tsx:19`, `app/app/qualify/error.tsx:30`. **No page can render two.** |
| FP-8 | 26 hits: `role="status"`/`role="alert"` "without explicit `aria-live`" across `v3/resolution-flow.tsx` and others | `role="status"` carries **implicit** `aria-live="polite"`; `role="alert"` implicit `assertive`. Neither needs the attribute. This file deliberately routes one `aria-live="polite"` sr-only region (`:4718`) and documents at `:361-364`, `:3487`, `:4198` why the streaming containers are **not** live regions. **This is a correctly-reasoned architecture.** The real problem is the *count* in shell mode — §5, not the markup. |
| FP-9 | Per-component "missing `<main>` / skip-link / `<h1>`" across 40 files | Page-level checks misapplied to components. Desktop `/qualify` supplies `<main>` at `resolution-flow-client.tsx:1375` and `:1421` (both branches) and `qualify-tab.tsx:958`, plus one `<h1>`. **The mobile route is the genuine exception — M2.** |

---

## 7. DEFINITION OF DONE

1. Six Criticals and fourteen Majors each **fixed** or returned `stillPresent:false` **with evidence**.
2. The re-measured contrast table, diffed against §5, showing **every previously-failing pair now passing and no previously-passing pair regressed**.
3. Tests: keyboard-operability tests for C-1, C-2, C-3, M3, M11 (dialog/menu focus contracts are testable in jsdom; **pointer/swipe is not** — `.claude/rules/qualify.md` already records that right-swipe has no test for exactly this reason. **Say so rather than adding a test runner.**)
4. A written recommendation on the §5 live-region-vs-header conflict.
5. All five gate commands green, **exact counts**.
6. Diff summary: files touched, lines ±, the three changes you are **least** confident in — and explicitly, **which findings you could only verify in a browser and did not.**
7. `gh pr create --base main` — **HOLD before pushing**, show me the PR body.
8. No `Co-Authored-By` trailer.
9. Anything discovered outside this list: **separate follow-up**, not folded in.
