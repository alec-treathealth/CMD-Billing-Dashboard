/**
 * Maintenance interstitial for the Claims Audit surface (/billing-audit). Shown in place of the
 * workbench when CLAIMS_AUDIT_MAINTENANCE is enabled (on by default during the refactor). The bypass
 * allowlist reaches the live workbench (see the route page) so the rebuild can be verified live.
 *
 * Server component: no client JS. Unlike the Qualify notice there's no Sign out button — these users
 * have a full dashboard, so the surrounding nav lets them move to another tab.
 */
export function ClaimsAuditMaintenanceNotice() {
  return (
    <main className="mx-auto flex min-h-[60vh] max-w-xl flex-col items-center justify-center gap-4 p-10 text-center">
      <span className="text-3xl" aria-hidden>
        🤖
      </span>
      <h1 className="text-2xl font-semibold tracking-tight">Claims Audit is being rebuilt</h1>
      <p className="text-sm text-muted-foreground">
        This tab is currently being refactored into an AI system. Hang tight, new functionalities
        coming soon!
      </p>
    </main>
  );
}
