/**
 * Collections route — the CMD charge-line detail (cmd_explorer_rows) via <CollectionsView />.
 * Filterable by Facility/Month; patient identifiers are masked by default and revealed in
 * bulk on an explicit, audited "Reveal all" click. Entity scope comes from the on-page tenant
 * tabs (?view=), resolved here and passed down through the viewToEntityIds seam.
 *
 * RBAC: gated + view-clamped like the overview. `canRevealPhi` (admins + super-admins) is passed
 * down so a plain `user` role never sees the "Reveal all" control (and the reveal action is gated
 * server-side regardless).
 */
import type { Metadata } from 'next';
import { Suspense } from 'react';
import { redirect } from 'next/navigation';
import { CollectionsView } from '@/components/dashboard';
import { DataFreshness, FreshnessLinePlaceholder } from '@/components/dashboard/data-freshness';
import { TenantTabs } from '@/components/dashboard/tenant-tabs';
import { UnprovisionedNotice } from '@/components/dashboard/unprovisioned-notice';
import { dashboardAccess } from '@/lib/access';
import { listGridViews, loadCmdReport } from '@/lib/actions';
import { clampView, resolveView } from '@/lib/views';
import { isQualifyOnlyRole, QUALIFY_HOME } from '@/lib/rbac';

export const metadata: Metadata = { title: 'Collections | CMD Billing' };

export default async function CollectionsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const access = await dashboardAccess();
  if (!access.ok) {
    if (access.reason === 'unauthenticated') redirect('/login');
    return <UnprovisionedNotice email={access.user.email} />;
  }
  // admissions_seat sees ONLY Qualify — block direct-URL access to every other route, server-side.
  if (isQualifyOnlyRole(access.access.role)) redirect(QUALIFY_HOME);
  // Fail closed: a provisioned role entitled to NO views (entity-scoped role with a null
  // entity — forbidden by the app_user CHECK) must not fall through to clampView's
  // consolidated (cross-tenant) default. Treat it as unprovisioned.
  if (access.access.allowedViews.length === 0) {
    return <UnprovisionedNotice email={access.access.user?.email} />;
  }

  const requested = resolveView(await searchParams);
  const view = clampView(requested, access.access.allowedViews);
  if (view !== requested) redirect(`/dashboard/collections?view=${view}`);

  // Server-render the initial grid: fetch the first page (default sort, no filter) + the caller's
  // saved column views IN PARALLEL, server-side, so the explorer paints WITH data in the initial
  // HTML instead of firing serialized client round-trips on mount. Both are fast (the row query is
  // index-backed; saved views is a tiny per-user lookup). Facility options are deliberately NOT
  // fetched here: it's a non-critical filter dropdown whose rare cold rebuild is slow, and we must
  // never let it block the page render — the client fetches it after paint. Each action fails
  // closed to {ok:false} internally, so a slice that errors just degrades to its client fetch.
  const [report, savedViews] = await Promise.all([
    loadCmdReport(null, {}, undefined, view),
    listGridViews(),
  ]);

  return (
    /* BOUNDED FLEX COLUMN — the results grid scrolls inside its own container; the document does
       not. Everything below depends on this element having a REAL height: `flex-1 min-h-0` further
       down resolves against it, and without a bound here every descendant falls back to content
       height and the page scrolls again (the shipped bug this replaces).

       The height is the viewport minus the 3.5rem (`h-14`) global header in app/layout.tsx.
       HeaderGate DOES render that header on this route — `isFullPageRoute('/dashboard/collections')`
       is false (lib/shell.ts: the set is /login, /forgot-password, /set-password, plus the
       /qualify/m prefix) — so the subtraction is not an assumption.

       `dvh`, not `vh`: on mobile the visual viewport shrinks as the URL bar retracts, and `vh`
       would park the pager under the browser chrome. Viewport-RELATIVE is also what keeps this
       usable at 200% zoom (WCAG 1.4.4) — never substitute a px height here.

       When the filter panel plus the grid's min-height floor exceed this box, the content
       overflows and the DOCUMENT scrolls. That is the intended fallback, not a failure: a
       container-scrolled grid is the normal-desktop behaviour, not an absolute. */
    /* VERTICAL PADDING IS ASYMMETRIC ON PURPOSE, and only the BOTTOM half is load-bearing.
       `sm:pb-8` rather than the shell's usual `sm:p-10`: on a viewport-bounded route the 8px per
       side that the standard shell spends below the content is the difference between the pager
       sitting on screen and the document scrolling — measured at 1440x900, it closes the last 4px
       of overflow, and it is also the slack that absorbs a small floor overflow without a
       scrollbar (see the grid's floor note).
       `sm:pt-4` (2026-09-04): the TOP padding was never load-bearing — nothing sits above the
       header but the global h-14 bar this box is already subtracting — so 16px of it goes back to
       the grid. Do not "restore symmetry" by putting it back; and do not take it out of pb-8.
       `gap-4`, not `gap-6`, for the same reason: there is exactly ONE gap left in this column
       (header -> CollectionsView) now that the tabs and the freshness line share a row, and 24px
       of it was buying nothing a 16px gap does not. */
    <main className="mx-auto flex h-[calc(100dvh-3.5rem)] max-w-[1800px] flex-col gap-4 p-6 sm:px-10 sm:pt-4 sm:pb-8">
      {/* ONE ROW FOR THE TENANT TABS AND THE FRESHNESS LINE (2026-09-04). They used to be two
          stacked blocks separated by a `gap-6`: tabs, then a <header> carrying the page title and
          the freshness line. Measured in a headless-Chromium replica of this column, that cost
          180.5px above the grid at 1440x900; folding them into one row (with the h1 made sr-only
          and the top padding halved) brings it to 74.5px. The 106px goes straight to the grid,
          which is the only element on this route that can use it — see the floor note in
          cmd-explorer.tsx.

          `items-center` aligns the 18px freshness line against the 42.5px tablist, which is what
          sets the row height. `flex-wrap` + `gap-y-1` is the narrow-viewport escape: at 200% zoom
          the two do not fit side by side, so the row becomes two lines (64.5px) rather than
          squashing either one — 84px of the reclaim survives there.

          ⚠ TENANTTABS IS A DIRECT CHILD HERE — NO WRAPPER DIV, AND THAT IS LOAD-BEARING TWICE
          OVER (both halves measured; Qodo #323 caught both). The first draft wrapped it in a
          `<div className="shrink-0">`, carried over from the old COLUMN layout where `shrink-0`
          meant "do not squash vertically". In a ROW it means "do not shrink horizontally", which
          is the opposite of what the tablist needs: its own `flex-wrap` can only wrap when its
          containing block is constrained, so the non-shrinking wrapper took the tablist's
          max-content width and the page overflowed HORIZONTALLY — measured at 111px past the
          viewport at 390px wide and 181px at 320px, a WCAG 1.4.10 reflow failure, with the tabs
          stuck on one line. As a direct child it shrinks to its own min-content instead and wraps
          to 2 lines at 390px, 3 at 320px, with zero overflow.
          And the wrapper is ALSO why `justify-between` needed a condition: when a single-entitled-
          view user makes TenantTabs return null, the empty wrapper was still a zero-width flex
          item occupying `space-between`'s first slot, which pushed the freshness line to the right
          edge of an 1800px container. With no wrapper there is no item, and `space-between` puts a
          lone item flush with main-START — measured at x=40, i.e. exactly the `sm:px-10` inset.
          So the condition is gone, and with it the reason to reach into TenantTabs for a
          visibility predicate at all: that predicate was an export from a `'use client'` module
          being CALLED by this server component, which the compiled server chunk turns into
          `throw Error("Attempted to call tenantTabsVisible() from the server…")` — a 500 on every
          render of this route, invisible to `next build` because the route is dynamic and never
          prerendered. Do not reintroduce the wrapper, and do not call anything from a client
          module here (a test pins both). */}
      <header className="flex shrink-0 flex-wrap items-center justify-between gap-x-6 gap-y-1">
        {/* NO SUBTITLE, deliberately (Alec, 2026-09-03). It read "CMD charge-line detail,
            filterable by facility and month. Patient identifiers are masked by default and revealed
            in bulk on an explicit, audited action." — every clause of which the page itself already
            says: the filters are visible controls, and the masked cells sit next to a "Reveal all"
            button. Prose that restates a visible affordance costs vertical space on a
            viewport-bounded route and teaches nothing.
            ⚠ Removing the SENTENCE changes no BEHAVIOUR: masking and the audited reveal are
            enforced server-side (canRevealPhi + the gated action), never by telling the reader
            about them. */}
        {/* SR-ONLY, NOT DELETED (2026-09-04). The visible heading was redundant on screen — the
            global nav already marks Collections as the active route, so the title restated a label
            the reader can see — but a page still needs an h1, and deleting it would leave
            this document's heading order starting at <h2> (WCAG 1.3.1 / 2.4.6). `sr-only` keeps the
            landmark for assistive tech and the document outline while returning its 32px line box
            plus the header's internal gap to the grid. Do not "simplify" this to no h1 at all, and
            do not make it visible again without re-deriving the grid floor below it. */}
        <h1 className="sr-only">Collections</h1>
        {/* Same control, same placement as Overview — see the note there. NOT wrapped: see the
            header's own note for why a `shrink-0` wrapper broke wrapping and stranded the
            freshness line. TenantTabs takes no className and needs none — as a flex item its own
            root (`flex flex-wrap items-center gap-2`) shrinks to min-content and wraps. */}
        <TenantTabs allowedViews={access.access.allowedViews} />
        {/* ⚠ THIS IS THE APP'S FIRST DATA-STREAMING SUSPENSE BOUNDARY, and it is not the same
            mechanism as the four in app/layout.tsx. Those wrap CLIENT components that call
            useSearchParams, with fallback={null} — a CSR bailout so the static routes sharing that
            layout can still prerender; their fallback is a formality that never meaningfully paints.
            THIS one wraps an ASYNC SERVER component that awaits a database read, so the fallback is
            LOAD-BEARING: it is what the reader actually sees until the probe resolves. Do not
            "simplify" it to null — see the reserved-box rationale on FreshnessLinePlaceholder.
            ⚠ WHAT IT HOLDS CHANGED WITH THE ROW (2026-09-04). It used to hold the <header>'s
            height outright; now the tablist beside it is the taller item, so the row is
            height-stable for anyone who sees tabs. For a single-entitled-view user TenantTabs
            renders null and this line IS the row — the reserve is still the only thing standing
            between them and an 18px jump on every cold load.

            WHY THE BOUNDARY EXISTS: DataFreshness is a freshness LABEL that was sitting on the
            blocking shell path. Un-suspended, React cannot flush any of this page until its read
            resolves, and that read is a single-connection pool with a 2s acquire budget and one
            jittered retry (lib/dataFreshness.ts) — an envelope measured at up to ~4.4s in the
            acquire-failure mode, which is observed failing in production. An annotation must not
            be able to hold the grid it annotates. */}
        {/* `inline` on BOTH halves, and they must move together: it drops the stacked variant's
            `mt-2`, which the row's `items-center` makes wrong (the line would sit ~4px below its
            neighbours' centre line). The fallback shares one class-list function with the real
            line, so passing it to one and not the other is a shift — a parity test asserts both
            placements. */}
        <Suspense fallback={<FreshnessLinePlaceholder inline />}>
          <DataFreshness view={view} inline />
        </Suspense>
        {/* Facility Resolution's entry point MOVED to the Claims Desk header (Alec, 2026-08-17):
            the workbench changes claim attribution, which is desk work, not collections reporting.
            The old route still forwards, so nothing breaks — but this tab no longer advertises it,
            deliberately. Do not re-add a link here. */}
      </header>
      <CollectionsView
        view={view}
        canRevealPhi={access.access.canRevealPhi}
        initialData={{ report, views: savedViews }}
      />
    </main>
  );
}
