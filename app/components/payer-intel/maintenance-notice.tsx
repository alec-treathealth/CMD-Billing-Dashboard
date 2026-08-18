/**
 * Maintenance interstitial for the Payer Intel surface (/payer-intel). Shown in place of the board
 * when PAYER_INTEL_MAINTENANCE is enabled (on by default). The bypass allowlist reaches the live
 * board so work can be verified against production.
 *
 * Server component: no client JS.
 *
 * ⚠ THE LINKS ARE CONDITIONAL, AND THAT IS THE WHOLE REASON THIS IS NOT JUST A COPY OF THE CLAIMS
 * DESK NOTICE. `admissions_seat` is a Payer-Intel-ONLY persona — `navLinksFor` gives it exactly one
 * link, this page — so for that role there IS no Overview or Collections to escape to. Offering
 * those links anyway would send them to a redirect and back, which reads as a broken app rather
 * than a paused tab. When `hasFullDashboard` is false the notice says its piece and stops.
 */
import Link from 'next/link';

export function PayerIntelMaintenanceNotice({
  /** True for roles that have somewhere else to go (super_admin). False for admissions_seat, whose
   *  only surface is this one. */
  hasFullDashboard,
}: {
  hasFullDashboard: boolean;
}) {
  return (
    <main className="mx-auto flex min-h-[60vh] max-w-xl flex-col items-center justify-center gap-4 p-10 text-center">
      <span className="text-3xl" aria-hidden>
        🛠️
      </span>
      <h1 className="text-2xl font-semibold tracking-tight">Payer Intel is being rebuilt</h1>
      <p className="text-sm text-muted-foreground">
        This tab is temporarily unavailable while it is being reworked. Your data is unaffected —
        nothing has been lost, and access will return here when the work lands.
      </p>
      {hasFullDashboard && (
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
      )}
    </main>
  );
}
