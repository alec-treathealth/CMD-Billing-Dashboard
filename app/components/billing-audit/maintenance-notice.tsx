/**
 * Maintenance interstitial for the Claims Desk surface (/billing-audit). Shown in place of the
 * workbench when CLAIMS_AUDIT_MAINTENANCE is enabled (on by default during the refactor). The bypass
 * allowlist reaches the live workbench (see the route page) so the rebuild can be verified live.
 *
 * Server component: no client JS. Two links let the viewer jump to a working surface (Overview /
 * Collections) — these users have a full dashboard, so both destinations resolve for them.
 */
import Link from 'next/link';

export function ClaimsAuditMaintenanceNotice() {
  return (
    <main className="mx-auto flex min-h-[60vh] max-w-xl flex-col items-center justify-center gap-4 p-10 text-center">
      <span className="text-3xl" aria-hidden>
        🤖
      </span>
      <h1 className="text-2xl font-semibold tracking-tight">Claims Desk is being rebuilt</h1>
      <p className="text-sm text-muted-foreground">
        This tab is currently being refactored into an AI system. Hang tight, new functionalities
        coming soon!
      </p>
      <div className="flex flex-wrap items-center justify-center gap-2">
        <Link
          href="/dashboard"
          className="rounded-md border border-line px-4 py-2 text-sm font-medium text-ink900 transition-colors hover:bg-teal50"
        >
          Go to Overview
        </Link>
        <Link
          href="/dashboard/collections"
          className="rounded-md border border-line px-4 py-2 text-sm font-medium text-ink900 transition-colors hover:bg-teal50"
        >
          Go to Collections
        </Link>
      </div>
    </main>
  );
}
