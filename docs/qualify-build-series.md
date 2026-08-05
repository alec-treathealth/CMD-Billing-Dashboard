# QUALIFY — CC BUILD SERIES (5 prompts, run in order, HOLD between each)

Context for you (Alec), not for CC: this series builds ONE backend contract
consumed by TWO frontends — the desktop web tab (built to the layout
proposal you already reviewed and approved) and a mobile PWA (built to the
swipe-deck design you approved). Prompts 1-2 are shared infrastructure.
Prompts 3 and 4 are independent and can run in parallel once Prompt 2 is
merged, since they only depend on the contract, not on each other. Prompt 5
is the joint QA + handoff.

Paste each numbered prompt into CC as its own session/turn. Do not skip
ahead — each one assumes the prior one is merged and its HOLD was cleared
by you.

STANDING CORRECTION (applies to every prompt below, read before starting):
Qualify reads CROSS-TENANT — both BXR and Indigo — by design. This is a
DELIBERATE, EXPLICIT EXCEPTION to the row-level tenancy pattern
(business_entity_id + RLS) that gates every other tab in this app. Every
other surface in CMD-Billing-Dashboard scopes to a single resolved
business_entity_id per session; Qualify does not, because admissions is
qualifying a lead against payer behavior across the whole book, not one
entity. This must be modeled as an explicit, named, reviewed exception —
never as an accidentally-missing WHERE clause, and never as CC quietly
applying the standard single-tenant pattern out of habit. Call it out in
code comments and in the Prompt 1 report specifically.

Second correction — a new role is being added, not repurposing an
existing one. RATIFIED: a new role `admissions_seat` will be added to the
role ladder (alongside super_admin / admin+entity / user+entity). Its
definition is simple and absolute, with NO exceptions or sub-flags:
  - `admissions_seat` sees ONLY the Qualify tab — no Overview, no
    Collections, no Claims Audit, no Code Reference. This is a NAV-LEVEL
    restriction, not just a data restriction: the nav itself must not
    render the other tabs for this role, AND the route layer must block
    direct-URL access to those other routes for this role.
  - `admissions_seat` NEVER sees dollar amounts inside Qualify — always
    percentages only, no exceptions, no per-account toggle. This is not
    a capability flag; it is simply what the role means.
  - Ravie and Ryan Lupton are NOT `admissions_seat` accounts. They keep
    their existing `super_admin` provisioning, which already grants full
    access to everything including dollars. There is no new capability
    flag to build for them — the amounts gate inside Qualify is simply
    "is this session super_admin," exactly like every other
    amounts-bearing surface in the app already works. This eliminates
    the need for any capability-independent-of-role-tier design; do not
    build one.
  - The existing `user`-tier remains untouched and unassigned — it is
    not being repurposed for admissions. `admissions_seat` is a distinct,
    new role.

=====================================================================
PROMPT 1 — INVESTIGATION + SHARED API CONTRACT (read-only, no code)
=====================================================================

ROLE & DISCIPLINE

You are a senior engineer embedded with Alec Lowi on CMD-Billing-Dashboard
(main, production). Read IN FULL before anything:
`docs/Fable Build Doc E2E/00-GUIDE.md`, the root `CLAUDE.md` (+ the
relevant `.claude/rules/*.md`), veris-data-notes.md. Surface — never silently
resolve — any conflict between those docs and observed reality.
(Path corrected 2026-07-26: 00-GUIDE.md lives under `docs/Fable Build Doc E2E/`, NOT the repo root;
`Veris-Plan-Reconciliation-and-Next-Steps.md` does not exist anywhere in the repo — dropped.)

This prompt is READ-ONLY. No files are created or modified. Trunk-based on
main; nothing here touches main regardless.

SCOPE

Investigate and report on five things, then propose ONE typed API
contract that both a desktop tab and a mobile client will consume
identically. Do not build UI. Do not write the route yet (that's Prompt 2).

INVESTIGATE (report findings, cite file paths + line numbers where useful)

1. Real top-nav component: confirm design-system.md's `NavLinks` (or
   correct name), usePathname() pattern, and how Overview / Collections /
   Claims Audit / Code Reference are registered + RBAC-gated. Confirm
   where "Qualify" slots between Overview and Collections. ALSO confirm:
   how would a nav-level restriction be implemented so that an
   `admissions_seat` session renders ONLY the Qualify link and none of
   the others? Identify whether this is a simple conditional in the
   existing nav-registration list or requires a new pattern.

2. The capability surface: app/lib/rbac.ts / access.ts / executive.ts —
   roles super_admin / admin+entity / user+entity. Report on:
   (a) the cleanest way to add a NEW role `admissions_seat` to this
   ladder — confirm whether roles are an enum, a string column, or
   something else, and what the minimal migration looks like (HOLD, DDL
   shown, in Prompt 2 — do not apply here);
   (b) confirm the amounts gate is simply the EXISTING super_admin check
   already used elsewhere in the app — RATIFIED: no new capability flag
   is needed. Ravie and Ryan Lupton stay on their current super_admin
   provisioning; `admissions_seat` accounts never see dollars, ever, by
   definition of the role. Confirm this matches how amounts-gating
   already works on other tabs, so Qualify is consistent rather than
   inventing a second pattern.

2a. TENANCY EXCEPTION — confirm and document explicitly: Qualify reads
   across BOTH BXR (entity af504ab6-3dcd-4aa4-a93c-27bc58de4088) and
   Indigo (entity 141d459c-f371-4229-9a92-ace198e940bb), unlike every
   other tab which scopes to a single resolved business_entity_id. Find
   where the standard single-tenant WHERE is applied today (withTenant.ts
   per the locked architecture) and report exactly how Qualify's queries
   will DIFFER from that pattern — e.g. WHERE business_entity_id = ANY(
   ARRAY[bxr_uuid, indigo_uuid]) instead of the single-value comparison.
   This must be an explicit, commented, reviewed exception in the code —
   not a missing filter. Flag this prominently in your report; this is
   the single highest-risk item in this series if gotten wrong, since a
   silent regression here either leaks Indigo data into a BXR-only
   surface elsewhere, or accidentally narrows Qualify to one entity when
   it should see both.

3. The collections read path: routes reading
   collections.cmd_explorer_charge_rollup (migration 0050); confirm the
   posting-grain dedup discipline (~2.14 rows/logical charge — never SUM
   raw cmd_explorer_rows; MAX() insurance_payments per charge); confirm
   how lib/phi.ts isPhiColumn()/displayCell()/ResultsTable mask + audited
   reveal work today.

4. The existing encrypted/audited lookup (member-ID exact + 3-letter
   alpha prefix) and the cohort panel (prefix-wide, dollar-weighted,
   N=5 suppression). Qualify REUSES this resolution path — confirm its
   exact function signatures/inputs so the contract below can call it.

5. The existing 7d/14d/30d/Month-Year time control in the filter bar —
   confirm its shape so Qualify's window selector (7/14/30/60/90 per the
   approved designs) can share the same underlying query parameterization
   even though the UI choices differ slightly from Collections' set.

PROPOSE: ONE SHARED CONTRACT

Design (do not implement) a single server contract — e.g.
`getQualifySnapshot(input): QualifySnapshot` as a Server Action, or a
route handler if that fits existing conventions better — with this
approximate shape (adjust field names/types to match real conventions
found in #1-5, but do not change the semantics):

  input:
    { query: string,            // member ID OR alpha prefix, sniffed server-side
      windowDays: 7|14|30|60|90 }

  output (QualifySnapshot):
    { resolved: { payerName: string, matchedOn: 'member_id'|'prefix',
                  matchedValue: string, totalCharges: number,
                  facilityCount: number, windowStart: string,
                  windowEnd: string } | null,   // null => no-data / VOB path
      facilities: Array<{
        rank: number, name: string, city: string, state: string,
        pctAllowedOfBilled: number,       // 0-100, dollar-weighted
        billedAmount: number | null,      // null unless capability
        allowedAmount: number | null,     // null unless capability
        lineCount: number,
      }>,
      cases: Array<{
        memberIdMasked: string,           // e.g. "AET•••4471"
        facilityName: string,
        program: string,
        lastDos: string,
        pctAllowedOfBilled: number,
        billedAmount: number | null,      // null unless capability
        allowedAmount: number | null,     // null unless capability
      }>,
      viewerHasAmountsCapability: boolean,
      tenantScope: 'cross-tenant-bxr-indigo',   // literal marker, always
                                                  // this value for Qualify —
                                                  // exists so the field is
                                                  // impossible to omit or
                                                  // forget silently
    }

Critical property this contract must guarantee: when
viewerHasAmountsCapability is false, billedAmount/allowedAmount are
ABSENT or null server-side in every element — never present-but-hidden.
This is the property Prompts 3 and 4 both depend on and neither should
have to re-implement.

Second critical property: viewerHasAmountsCapability is the SAME
super_admin check already used elsewhere in the app — no new capability
flag, no independent-of-role modeling. admissions_seat sessions are
always false here, by definition of the role, with no exceptions. And
every query behind this contract reads across BOTH BXR and Indigo
explicitly (finding #2a) — never the single-entity WHERE used elsewhere
in the app.

FIRST OUTPUT

A single read-only report: the five investigation findings, then the
proposed contract (adjusted for real naming conventions), then a short
list of anything that needs my ruling before Prompt 2 (e.g. capability
mechanism, exact function names to reuse). No code. STOP for my go.

=====================================================================
PROMPT 2 — SERVER + DATA LAYER (implements the contract from Prompt 1)
=====================================================================

ROLE & DISCIPLINE — same as Prompt 1. Trunk-based, HOLD before any
migration or commit, surgical git add, no Co-Authored-By trailer.

PREREQUISITE: Prompt 1's report is approved and its contract is final.
Paste that approved contract here if starting a fresh CC session.

Non-negotiable (HIPAA/SOC2/OWASP, always on):
- PHI (patient_name, member_id, group_number) never in logs, prompts,
  URLs, or summary objects. Masked by default; no reveal on this feature.
- Parameterized queries + column allowlists only. Pooler port 6543 — no
  named prepared statements. Least-privilege reader role.
- business_entity_id resolved from the AUTHENTICATED SESSION only, never
  from request body/query/header.
- Dollar amounts are authorization-gated exactly like PHI: STRIPPED
  SERVER-SIDE for non-capability sessions. Frontend hiding is NOT
  acceptable — verified by an automated wire-level test, not a visual
  check.
- Fail closed: generic client errors, detail to logs only, no PHI/member
  ID in any log line.

SCOPE
IN:  the server implementation of QualifySnapshot from Prompt 1 — search
     resolution, facility ranking, cases query, amounts-capability gate.
OUT: any UI. No new ingest/ETL. No Veris brains. No new migrations unless
     the amounts-capability mechanism requires one (HOLD with DDL shown).

THE WORK

1. Implement the amounts gate as the EXISTING super_admin check already
   used elsewhere in the app — RATIFIED, no new capability flag. The
   only new migration in this feature is adding `admissions_seat` to the
   role enum/column (per Prompt 1 finding #2a) — HOLD here with DDL +
   rollback shown before applying that migration.

1a. TENANCY EXCEPTION — implement explicitly. Every query in this
   feature reads WHERE business_entity_id = ANY(ARRAY[
   'af504ab6-3dcd-4aa4-a93c-27bc58de4088'::uuid,   -- BXR
   '141d459c-f371-4229-9a92-ace198e940bb'::uuid    -- Indigo
   ]) — NOT the single-entity comparison withTenant.ts applies
   elsewhere. Add a prominent code comment at every query site stating
   this is a deliberate, reviewed, cross-tenant exception specific to
   Qualify, so a future engineer (or future CC session) doesn't "fix" it
   into the standard single-tenant pattern. Add a test asserting a
   Qualify query result CAN contain rows from both entities
   simultaneously — a regression here (accidentally narrowing to one
   entity) should fail loudly, not silently return partial data.

1b. NAV-LEVEL ROLE RESTRICTION — implement the new `admissions_seat` role
   so a session with that role renders ONLY the Qualify nav entry.
   Enforce at BOTH the nav-registration layer AND the route layer — an
   `admissions_seat` session hitting /collections or /claims-audit
   directly by URL must be redirected/blocked server-side, not just
   visually hidden from nav. Same DOM-vs-wire distinction as the amounts
   gate: hiding a link is not the same control as blocking the route.

2. Implement search resolution calling the EXISTING lookup/cohort code
   confirmed in Prompt 1 — member-ID exact (blind-index, audited) OR
   3-letter alpha prefix. No name search, no substring path. Sniff which
   shape the query string is server-side (do not ask the client to
   declare it).

3. Implement the facility ranking query against
   cmd_explorer_charge_rollup: SUM(allowed)/SUM(billed) per facility,
   dollar-weighted, never SUM of raw posting rows. Parameterized by
   resolved payer + windowDays + the two-entity array from #1a. Return
   top result set ordered by pctAllowedOfBilled desc (both desktop and
   mobile paginate/deck this the same ranked list; ordering must be
   identical across both consumers). Facilities from BOTH BXR and Indigo
   appear in one ranked list — do not silently group or split by entity
   unless Alec asks for that later.

4. Implement the cases query: 15 most-recent DISTINCT patients for the
   resolved payer in-window, across BOTH entities per #1a. Masked shape
   only (memberIdMasked, never raw). Keyset/limited, parameterized.

5. Implement the capability gate as the LAST step before serialization:
   strip billedAmount/allowedAmount to null (or omit the keys entirely —
   pick one and be consistent) for any session without the capability.
   This must happen in one place, not duplicated per-field, so it can't
   be forgotten on a new field later.

6. Write the wire-level test: a non-capability session's JSON response
   is asserted to contain zero dollar values anywhere in the payload
   (not a DOM/render assertion — the actual response body). A
   capability session's response is asserted to contain them.

7. No-data path: when resolution returns zero matches, `resolved` is
   null and facilities/cases are empty arrays — the frontends render
   their respective VOB modal off of `resolved === null`, not off of
   an empty-array check (empty array with a valid resolved payer is a
   legitimate "this payer has no facilities in this window" state,
   which is different from "never heard of this identifier").

DEFINITION OF DONE
- QualifySnapshot implemented exactly to the approved contract.
- Wire-level amounts test green for both capability states.
- Cross-tenant test green: a single Qualify query result provably
  contains rows from both BXR and Indigo when both have matching data.
- Nav/route restriction test green: an `admissions_seat` session cannot
  reach Collections/Claims Audit/Code Reference by direct URL, not just
  by nav.
- Typecheck clean, no secret in any client-reachable bundle (grep).
- No PHI/member_id/full identifier in logs (grep test logs too).

HOLD GATES
HOLD before any migration (DDL + rollback shown). HOLD before commit/push.

FIRST OUTPUT: the implementation plan + exact function/route signatures,
before writing code. Then STOP for my go.

=====================================================================
PROMPT 3 — DESKTOP WEB TAB (build to the approved layout proposal)
=====================================================================

ROLE & DISCIPLINE — same as above.

PREREQUISITE: Prompt 2 is merged. The QualifySnapshot contract is live
and callable.

ATTACHED REFERENCE: Alec is providing the file
`qualify-tab-layout-proposal.html` — an approved static mock. This is
your VISUAL AND STRUCTURAL SPEC. Match it closely: the ribbon-free
<!-- HISTORICAL (2026-07-28): this mock was superseded by the compose-bar
     redesign and deleted. The shipped layout is app/components/qualify/
     qualify-tab.tsx; the surviving comp is docs/mockups/
     qualify-redesign-mockup.html. Prompt text left intact as written. -->
production version of this exact layout — top bar nav slot between
Overview and Collections, the teal-900/coral-600/Fraunces (display) + Space
Grotesk (headings) + Inter (body) + IBM Plex Mono (numeric) TreatHealthOS
design-system tokens [corrected 2026-07-27: the app loads NO Hanken Grotesk
— globals.css @imports Inter/Space Grotesk/IBM Plex Mono/Fraunces; body font
is Inter, headings Space Grotesk, matching docs/design-system.md], the filter bar
(search + Resolve payer button + 7/14/30/Month segmented control — note:
confirm with Alec whether Qualify's window control should be
7/14/30/60/90 to match the mobile build, since the proposal shows
7/14/30/Month; ASK, do not silently pick), the resolved-payer chip, the
two-column grid (facility list-with-bars panel + cases table panel), the
color-layer toggle (pure view-state, confirmed in the proposal's JS),
and the no-data VOB modal (CTA ships inert with a marked TODO seam
unless Alec has since supplied a target).

SCOPE
IN:  wire the approved static mock to the real QualifySnapshot contract,
     real RBAC (replacing the proposal's client-side "View as" simulation
     with the actual session-derived viewerHasAmountsCapability), real
     nav registration, real color/threshold logic reading from the
     server response instead of hardcoded fixture values.
OUT: redesigning the proposal. If something in the proposal conflicts
     with the real contract's field names/shapes, adapt the contract
     consumption, not the visual design, and flag the conflict rather
     than silently changing either.

THE WORK

1. Register the "Qualify" route + nav entry exactly per Prompt 1's
   findings (real NavLinks component, RBAC-gated like sibling tabs,
   active-state styling from design-system.md).

2. Build the page shell matching the proposal: pagehead, filter bar,
   resolved-payer chip + context meta line, two-column grid (collapsing
   to one column under 960px per the proposal's existing media query).

3. Wire the search input + Resolve-payer button to call
   getQualifySnapshot; wire the time-window segmented control to pass
   windowDays.

4. Render the facility panel from `facilities[]`: rank badge, name,
   city/state, pct-allowed bar + colored left-border per the proposal's
   h-ok/h-warn/h-danger classes (0-24 danger / 25-49 warn / 50+ ok — READ
   THE THRESHOLDS FROM A SHARED CONSTANT, do not hardcode them twice
   across desktop and mobile — put them in one file both can import).
   `.amt` dollar spans render only when viewerHasAmountsCapability is
   true AND the field is non-null; otherwise the elements are omitted
   from the DOM entirely, not hidden with CSS (CSS-hiding still ships
   the value to the client, which defeats the entire point).

5. Render the cases table from `cases[]`: masked member ID, facility,
   program pill, last DOS, colored pct cell, `.amt` columns following the
   same real-omission rule as #4.

6. Wire the color-layer toggle exactly as the proposal's JS does — pure
   view state, no data refetch.

7. Wire the VOB modal to `resolved === null`. Echo the searched query
   value into the modal. "Start VOB" ships inert with a visible TODO
   comment (`// TODO(qualify-vob): wire to <target> once Alec confirms`)
   unless Alec has supplied a real target by this point — ask, don't
   assume silently.

DEFINITION OF DONE
- Route matches the proposal's visual fidelity closely enough that Alec
  can hold the two side by side and recognize it as "that, wired up."
- viewerHasAmountsCapability correctly gates every dollar element via
  DOM omission, verified by a rendered-HTML test (not just the
  wire-level test from Prompt 2 — this one checks the actual markup).
- Color thresholds imported from one shared constant, not duplicated.
- Responsive collapse works per the proposal's existing breakpoint.
- Typecheck clean.

HOLD GATES
HOLD before commit/push. HOLD if the proposal's window-control set
(7/14/30/Month) needs to be reconciled with the mobile build's
(7/14/30/60/90) — ask Alec rather than picking one silently.

FIRST OUTPUT: confirm you've read the attached proposal file in full,
list any field-name or threshold mismatches between it and the Prompt 1
contract, then the component-by-component build plan. STOP for my go.

=====================================================================
PROMPT 4 — MOBILE PWA (swipe-deck design, scoped route)
=====================================================================

ROLE & DISCIPLINE — same as above.

PREREQUISITE: Prompt 2 is merged. The QualifySnapshot contract is live.
This prompt does NOT depend on Prompt 3 — it can be built in parallel,
both reading the same contract, deliberately different visual registers.

ATTACHED REFERENCE: Alec is providing (or has already shared in-thread)
the mobile mockup files (qualify-app.jsx / qualify-app.html — both deleted
2026-07-28, superseded by docs/mockups/qualify-redesign-mockup.html) — the
approved swipe-deck design: a home screen with a search bar, 7/14/30/60/90
window selector, and a "This Month's Movers" trending-prefix module; a
results screen rendered as a draggable stacked card deck (Tinder-style
peek + drag-tilt + directional color glow, swipe right opens detail /
swipe left passes, tap also opens); a detail screen with the facility's
policy rating and its 15 most recent claims; back navigation throughout.
This is your VISUAL AND INTERACTION SPEC — match the drag physics,
peek-stack depth, and color-glow behavior closely, not just the static
layout.

SCOPE
IN:  a new scoped route (e.g. app/qualify/m/, confirm the right App
     Router convention with existing conventions) serving the mobile
     flow, a manifest + service worker SCOPED ONLY to that route, real
     data from QualifySnapshot replacing the mockup's fixtures, real
     RBAC/session auth (no separate login — same session as the main
     app), install-prompt affordance.
OUT: React Native / Capacitor / any native shell (explicitly descoped
     per Alec's product decision — this is PWA-only). Redesigning the
     approved interaction pattern. A parallel client-rendered-only
     export that bypasses Server Actions (out of scope; this stays
     inside the existing Next.js app).

THE WORK

1. Confirm per-segment manifest support in the installed Next.js version
   (app/qualify/m/manifest.webmanifest, scope "/qualify/m/", start_url
   "/qualify/m", short name something like "Lead Lookup" — not
   "TreatHealthOS" — since it's a single-purpose install for admissions).

2. Build the home screen: search bar (single input, sniffs member-ID vs.
   prefix server-side — reuses Prompt 2's resolution, no client-side
   toggle), 7/14/30/60/90 window selector, "This Month's Movers" module.
   The Movers list needs a real query — confirm with Alec whether this
   is a new aggregate (top prefixes by claim-volume delta over the
   window) or can be approximated from data already exposed by an
   existing report; if it requires new query work beyond what Prompt 2
   scoped, HOLD and flag rather than silently expanding Prompt 2's
   contract retroactively.

3. Build the results screen: the SwipeDeck component from the approved
   mockup, adapted to consume `facilities[]` from the real
   QualifySnapshot instead of fixture data. Preserve: stacked peek (2
   cards behind, scaled/dimmed by depth), drag-follow with rotation,
   directional glow + "Take it"/"Pass" stamps building in with drag
   distance, swipe-right-opens/swipe-left-passes/tap-opens, streak badge
   only when a real signal backs it (do NOT fabricate a "streak" if no
   such trend data exists yet in the contract — ask Alec whether this
   needs a Prompt-1-contract addition or should ship without the badge
   for v1).

4. Build the detail screen: policy rating card + last-15-claims list,
   consuming `cases[]` filtered to the tapped facility. Confirm with
   Alec whether "last 15 claims" scopes to the resolved payer overall
   (as built in Prompt 2) or should be re-scoped per-facility — this is
   a real semantic question the swipe mockup's fixture data glossed over
   (the mockup showed the same 15 claims regardless of which facility
   card was tapped). Do not silently pick; ask.

5. Wire the dollar-amounts gate identically to Prompt 3's rule: DOM
   omission, not CSS-hiding, driven by viewerHasAmountsCapability.

6. Service worker: cache the app shell/static assets only. EXPLICIT
   DENY-LIST — any response from the QualifySnapshot endpoint or any
   route under app/qualify/m/api/* (or wherever the data path lives) is
   NEVER cached by the service worker. Add an automated test that
   asserts the SW cache, after a full flow (search → results → detail),
   contains zero PHI-bearing or dollar-bearing response bodies.

7. Add an install-prompt affordance gated to the admissions role
   (trigger off beforeinstallprompt, don't rely on the native prompt
   alone since iOS Safari doesn't support it).

DEFINITION OF DONE
- Swipe/drag physics match the approved mockup's feel (peek depth, tilt,
  glow thresholds) — Alec should recognize it as the same interaction,
  not just the same layout.
- Manifest scoped correctly; installing from /qualify/m never exposes
  Overview/Collections/Claims Audit.
- Service-worker-never-caches-PHI-or-dollars test green.
- Amounts gate verified by rendered-markup test, same standard as
  Prompt 3.
- Any open semantic question (Movers query source, streak-badge data
  backing, per-facility vs. per-payer claims scoping) is answered by
  Alec BEFORE being silently resolved in code.

HOLD GATES
HOLD on any of the three flagged semantic questions in #2/#3/#4 before
building past them. HOLD before commit/push.

FIRST OUTPUT: confirm you've read the attached mobile mockup file(s) in
full, list the three flagged open questions above with your recommended
default for each, then the component-by-component build plan. STOP for
my go.

=====================================================================
PROMPT 5 — CROSS-SURFACE QA + HANDOFF
=====================================================================

ROLE & DISCIPLINE — same as above. This prompt assumes Prompts 3 and 4
are both merged.

SCOPE: verify parity between the desktop tab and the mobile PWA against
the SAME live resolved payer, and produce the session handoff.

THE WORK

1. Run the same search (same member ID or prefix, same window) against
   both surfaces. Confirm: identical resolved payer, identical facility
   ranking + percentages, identical case count and masked identifiers,
   identical color bucket per threshold (0-24/25-49/50+) on every shared
   data point.

2. Confirm the amounts gate holds identically on both surfaces for both
   capability states — re-run both wire-level and rendered-markup tests
   against both routes.

3. Confirm the VOB no-data path triggers identically on both (same
   `resolved === null` condition, same echoed query value).

4. Confirm the color-layer toggle (desktop) and any equivalent visual
   state (mobile) are pure view-state and don't cause a second network
   call.

5. Full typecheck + test suite across both surfaces. Grep for secrets in
   both client bundles. Grep logs from a full test run of both flows for
   PHI/member-ID leakage.

DEFINITION OF DONE
- Parity checklist above is green on both surfaces.
- No regressions in Overview/Collections/Claims Audit from the new nav
  entry or shared contract changes.

HANDOFF
Produce a self-contained continuation prompt (four sections, <500 words,
Alec's voice) covering: what shipped, what's still open (VOB CTA target,
Movers-query data source if deferred, streak-badge data backing if
deferred, per-facility vs per-payer claims scoping decision), and the
exact file paths/route names for both surfaces so a fresh session needs
zero re-discovery.

=====================================================================
ADDITION — SWIPE-TO-DISMISS (facility/payer list triage)
=====================================================================

CONTEXT FOR CC: Admissions triages a resolved payer's facility/case list
by eliminating irrelevant entries as they go, rather than paging through
them. This replaces pagination as the primary way to work through a long
list — swipe (or an equivalent explicit action on desktop, since swipe
gestures aren't native to mouse input) removes an item from the
currently-rendered list. A single "Restore all" control brings every
dismissed item on this search back into view — there is no per-item
undo; restoring is all-or-nothing.

SCOPE
IN:  a dismiss action on facility rows/cards (and case rows, if Alec
     confirms) that removes the item from the CURRENT rendered list
     only, plus one "Restore all" control that clears the entire
     dismissed set for the current search and re-renders everything.
     Dismissed state is tracked client-side, scoped to the current
     resolved-payer search — a new search or a page reload resets it.
     This is NOT a data mutation; nothing is written to the database,
     no facility/case is hidden from other users or future searches.
OUT: per-item undo (explicitly not wanted — "Restore all" is the only
     recovery path). Permanent/cross-session dismissal, any server-side
     blocklist table, any change to the underlying ranking query. If
     Alec later wants dismissals to persist per-user across sessions,
     that's a separate, explicitly-scoped follow-up requiring its own
     data model and audit-log review — do not build persistence unless
     asked.

DESKTOP (Prompt 3 surface)
The approved layout proposal uses a list-with-bars panel, not a swipe
deck — swipe gestures don't map to mouse/trackpad input. Implement the
equivalent affordance as an explicit per-row dismiss control (e.g. an X
or "not relevant" icon on hover/focus) that removes the row from the
rendered list immediately, no confirmation, no toast. Whenever the
dismissed count is > 0, show a persistent "Restore all (N)" control
(e.g. in the panel header, near the facility count) that clears the
dismissed set and re-renders the full list. The control disappears when
nothing is dismissed.

MOBILE (Prompt 4 surface, extends the existing SwipeDeck)
The SwipeDeck component already implements swipe-left as "pass" — this
addition changes what swipe-left MEANS: it now removes that facility
from the current search's deck, not just advances past it. Relabel the
existing gray stamp from "Pass" to something that reads as a real
dismissal (e.g. "Hide" — Alec's call), so the person understands the
card won't resurface by continuing to swipe. Add a persistent "Restore
all (N)" control, visible whenever N > 0, likely in the results-screen
header near the resolved-payer chip — tapping it clears the dismissed
set and resets the deck to the full ranked list. No per-item undo on
mobile either; this is the sole recovery path on both surfaces.

SHARED REQUIREMENT
Because dismissal is session-scoped and client-side only, it must never
leak into the actual ranking data — dismissing on one device/tab has no
effect on what any other session (or the same user's next session)
sees. Add a test on both surfaces confirming: (1) a dismissed item
disappears from the current render, (2) "Restore all" brings back every
dismissed item and resets the counter to zero, (3) a fresh search or
reload resets the dismissed set independently of "Restore all."

HOLD GATE: if Alec decides mid-build that dismissals SHOULD persist
per-user across sessions, STOP and flag this as a scope change requiring
a real data model (e.g. a dismissed_facilities table keyed to user +
payer) and a decision on whether that needs audit logging under the
existing HIPAA/SOC2 posture — do not silently upgrade a UI action into a
persisted preference.
=====================================================================
