# Claude Code Prompts — Design Unification + Beta Badges

Generated 2026-07-25. Three prompts, run in order. Prompt 1 ships in minutes; 2 and 3 are the
staged design-system work (audit → extract → apply).

**Run all of these from the repo root.** Note the repo has two `package.json` files — the Next.js
app lives in `app/`, so most paths below are `app/...`.

---

## Prompt 1 — "NEW" → "Beta", and add it to Claims Audit

Ship this first. It's independent of everything else.

```
Read app/components/nav-links.tsx and the `.q-new-badge` rules in app/app/globals.css
(around line 235).

Two changes:

1. The nav badge currently reads "NEW". Change the label to "Beta" everywhere it renders.
   Keep the shimmer gradient, the ✦ twinkle, and the prefers-reduced-motion handling exactly
   as they are — only the text changes.

2. Claims Audit (`{ href: '/billing-audit', label: 'Claims Audit' }` in BASE_LINKS) should
   carry the same badge as Qualify. Set the same flag on it.

While you're in there: the flag is named `isNew` on the `NavLink` type. Rename it to `isBeta`
and rename the CSS class `.q-new-badge` → `.q-beta-badge` (plus the two `@keyframes`
`q-new-shimmer` / `q-new-twinkle`) so the names match what they mean. Update every reference.
Do not leave an `isNew` alias behind.

Scope: only app/components/nav-links.tsx and app/app/globals.css. Do not touch any other
component, route, or the RBAC logic in linksFor() — Claims Audit's visibility rules stay
exactly as they are.

Verify before finishing:
- `cd app && npm run typecheck`
- grep the repo for `isNew` and `q-new-` to confirm zero remaining references
- Confirm the badge renders on exactly two nav items for super_admin (Qualify + Claims Audit),
  and on Qualify only for admissions_seat.
```

**Why it's shaped this way**

- Anchors on the two exact files and the line number, so CC doesn't go hunting.
- Bundles the rename into the same pass — `isNew` on a permanent Beta flag is the kind of
  drift that becomes a lie in three weeks.
- The grep check is the success criterion: a rename is only done when the old name is gone.
- Explicitly fences off `linksFor()` because that's the RBAC seam and CC will be tempted to
  "tidy" it while it's in the file.

---

## Prompt 2 — Audit and extract the Qualify visual language (no visual change)

This one writes documentation and a shared token layer, and changes nothing you can see.
Review its output before running Prompt 3.

```
This is an audit-and-extract task. Do NOT change how any page currently looks. Read first,
then write only the two outputs named at the bottom.

Context: the /qualify surface was built later than the rest of the app and has its own visual
system. Overview, Collections, Claims Audit, and Code Reference are still on plain shadcn
primitives and look dated next to it. Before restyling them, I want the Qualify visual
language written down and made importable.

Read, in this order:
  1. app/components/qualify/tokens.ts and app/components/qualify/colors.ts
  2. app/components/qualify/qualify-tab.tsx (the composition — how a page is assembled)
  3. app/components/qualify/overview.tsx, facility-panel.tsx, cases-table.tsx (card, panel,
     and table treatments)
  4. app/components/qualify/landing-hero.tsx, spark.tsx, useMarquee.ts (motion)
  5. The `.q-*` rules and the qualify-specific blocks in app/app/globals.css
  6. app/tailwind.config.ts (existing brand tokens, the ths-sm/ths/ths-lg elevation scale,
     the Inter/Space Grotesk/Fraunces/IBM Plex Mono type stack)
  7. docs/design-system.md — this ALREADY EXISTS and is stale. It predates all Qualify work.
     You are updating it, not creating a new one.

Then, for contrast, skim these to see what the other surfaces actually use today:
  app/components/dashboard/overview.tsx, overview-kpis.tsx, widgets.tsx,
  app/components/dashboard/collections-view.tsx,
  app/components/billing-audit/workbench.tsx, work-table.tsx,
  app/components/code-reference.tsx

Produce two outputs:

OUTPUT A — Update docs/design-system.md in place. Keep its existing structure (Palette,
Typography, Elevation, Layout, Components, Motion, Navigation, PHI rules) and bring it current.
For each visual element, document: the token or class that owns it, the file it's defined in,
and which surfaces currently honor it vs. which don't. Add a "Qualify → app-wide gap" section
that is a concrete, per-surface table: surface | element | what Qualify does | what this
surface does today | what it should become. Be specific about numbers — radii, shadow tiers,
padding scale, font sizes, animation durations and easings — not "modern feel."

OUTPUT B — Promote the surface-agnostic parts of components/qualify/tokens.ts and colors.ts
into a shared module that all surfaces can import. Put it wherever it belongs given the
existing structure (app/lib/ or app/components/ui/ — you decide and say why). Rules:
  - components/qualify/tokens.ts must keep working. Re-export from the new shared module
    rather than deleting it, so nothing under components/qualify/ breaks.
  - The shared module must stay pure and client-safe: no React, no server imports, RELATIVE
    imports only. app/test/qualify-render.test.tsx and qualify-mobile-render.test.tsx run
    hermetically under tsx WITHOUT tsconfig path-alias resolution — `@/` imports there will
    break them.
  - Do not touch app/components/qualify/m/** at all. The mobile PWA styles inline on purpose.

Hard constraints:
  - No visual change to any page in this pass. If a change would alter rendered output, stop
    and tell me instead of doing it.
  - Do not modify any component under components/dashboard/, components/billing-audit/, or
    code-reference.tsx in this pass. That's Prompt 3.
  - Do not add dependencies.

Before finishing:
  - `cd app && npm run typecheck`
  - `cd app && npm test` — all existing tests must pass unchanged
  - List every file you touched with a one-line reason
  - End with: the 3 highest-impact changes that would make the other tabs feel like Qualify,
    and the single riskiest one (the one most likely to break a data-dense table).
```

**Why it's shaped this way**

- Separates "look and tell me" from "now change it" — the single most common cause of a CC
  run you have to unwind.
- Names `docs/design-system.md` as **existing and stale**. Without that, CC writes a second
  design doc and you now have two sources of truth.
- The hermetic-test constraint (`relative imports, no @/`) is written into the prompt because
  it's non-obvious and CC will otherwise "clean up" the relative imports and break two tests.
- Ends by asking for a risk ranking, which gives you the running order for Prompt 3 instead
  of guessing.

---

## Prompt 3 — Apply the system, one surface per run

Run this **once per tab**, in the order Prompt 2 recommends. Swap the bracketed parts.
Do the lowest-risk surface first (likely Code Reference) to validate the system before it
touches a PHI table.

```
Read docs/design-system.md (just updated) and the shared token module it references. Then read
app/components/qualify/qualify-tab.tsx as the reference implementation of the visual language.

Restyle [SURFACE — e.g. "the Code Reference tab: app/components/code-reference.tsx and
app/app/code-reference/page.tsx"] so it matches the Qualify visual language documented in
design-system.md.

Success looks like: side by side with /qualify, this surface reads as the same product —
same card elevation and radii, same spacing rhythm, same type scale and weights, same status
color semantics, same motion character. A reviewer should not be able to tell which tab was
built first.

This is a PRESENTATION-ONLY change:
  - Do not change what data is fetched, filtered, sorted, or displayed.
  - Do not change any prop signature, route, query param, or server action.
  - Do not change RBAC, tenant scoping (?view=), or any PHI handling. [If the surface is
    Claims Audit, add: this surface is PHI + BXR-tenant-scoped. Do not add logging, do not
    change what fields render, do not widen anything that is currently gated.]
  - Do not touch any file outside [SCOPE PATHS].
  - Do not touch components/qualify/** — that's the reference, not the target.

Use the shared tokens. Do not introduce new hex values, new shadow definitions, or one-off
magic numbers. If the design system is missing something this surface genuinely needs, add it
to the shared module and to docs/design-system.md rather than inlining it here.

Work incrementally: before you edit each file, state in one line what you're changing and why.
If a change would require altering data flow or markup structure to work, stop and ask.

Before finishing:
  - `cd app && npm run typecheck`
  - `cd app && npm test`
  - `cd app && npm run build`
  - Summarize: every file changed, and any place you had to deviate from the design system.
```

**Why it's shaped this way**

- "Presentation-only" is stated as a hard boundary and then enumerated, because "restyle" is
  exactly the kind of instruction that quietly grows into a refactor.
- The success criterion is a comparison a human can actually run ("side by side with /qualify")
  rather than an adjective.
- "No new hex values" is the rule that keeps the system from decaying on contact — without it
  CC will match Qualify by hardcoding, and you're back where you started next quarter.
- Step-by-step announcement mode is on because these are dense files and you want a chance to
  interrupt mid-run.

---

## Suggested running order

1. Prompt 1 → commit → ship.
2. Prompt 2 → **read the updated `docs/design-system.md` yourself before continuing.** This is
   the review gate; everything downstream inherits whatever it says.
3. Prompt 3 × 4, in ascending risk: Code Reference → Overview → Collections → Claims Audit.
   Commit each separately so any one is revertible on its own.
