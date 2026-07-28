/**
 * Maintenance interstitial for the Qualify surface (desktop /qualify + mobile /qualify/m). Shown in
 * place of the tab when QUALIFY_MAINTENANCE is enabled. super_admin bypasses the gate (see the route
 * pages) so improvements can still be verified live while admissions_seat users see this notice.
 *
 * Server component: no client JS. Sign out posts the existing server action.
 */
import { signOut } from '@/lib/auth-actions';

export function QualifyMaintenanceNotice() {
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
      <form action={signOut}>
        <button
          type="submit"
          className="rounded-md border border-line px-4 py-2 text-sm font-medium text-ink900 transition-colors hover:bg-teal50"
        >
          Sign out
        </button>
      </form>
    </main>
  );
}
