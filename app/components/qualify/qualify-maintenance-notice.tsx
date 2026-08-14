/**
 * Maintenance interstitial for the Qualify surface (desktop /qualify + mobile /qualify/m). Shown in
 * place of the tab when QUALIFY_MAINTENANCE is enabled; the allowlist in `maintenance.ts` bypasses
 * it so improvements can still be verified live while everyone else sees this notice.
 *
 * Server component: no client JS.
 *
 * ⚠ THE EXITS ARE ROLE-DEPENDENT, AND THAT IS THE WHOLE POINT (audit 2026-08-12, P0-7). This
 * component used to render "Go to Overview" / "Go to Collections" unconditionally, and its own
 * docblock admitted the consequence: an `admissions_seat` has no dashboard access, so BOTH links
 * redirect straight back here (`isQualifyOnlyRole` → `redirect(QUALIFY_HOME)`). For that persona the
 * notice was a closed loop — two buttons that look like ways out and are not — and Qualify is their
 * only surface, so it was the entire product. There are zero seats provisioned today (measured
 * 2026-08-12: 13 super_admin, 3 admin, 0 admissions_seat), which makes this a trap waiting for the
 * first one rather than a live outage; it is fixed now because provisioning a seat is a one-row
 * change somebody will make on a Tuesday without reading this file.
 *
 * A qualify-only viewer gets the same honest status with NO exits, because for them there is
 * genuinely nowhere else to go. Offering a button that cannot work is worse than offering none.
 */
import Link from 'next/link';

export function QualifyMaintenanceNotice({
  /** True when the viewer's role can reach ONLY /qualify (rbac.isQualifyOnlyRole) — the pages pass
   *  it from the resolved access row. Defaults FALSE so an un-updated caller keeps today's links
   *  rather than silently hiding navigation from an admin who has it. */
  qualifyOnlyViewer = false,
}: {
  qualifyOnlyViewer?: boolean;
}) {
  return (
    <main className="mx-auto flex min-h-[60vh] max-w-xl flex-col items-center justify-center gap-4 p-10 text-center">
      <span className="text-3xl" aria-hidden>
        🤖
      </span>
      <h1 className="text-2xl font-semibold tracking-tight">Qualify is being rebuilt</h1>
      <p className="text-sm text-muted-foreground">
        This tab is currently being refactored into an AI system. Hang tight, new functionalities
        coming soon!
      </p>
      {qualifyOnlyViewer ? (
        // No links: every other surface redirects this role back to /qualify. Say what to do instead.
        <p className="text-sm text-muted-foreground">
          Qualify is the only surface on your account, so there is nothing else to switch to right
          now. Check back shortly, or contact your administrator if you need lead lookup today.
        </p>
      ) : (
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
