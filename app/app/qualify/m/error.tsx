'use client';

/**
 * Route error boundary for the mobile Qualify PWA (/qualify/m). Same intent as the desktop
 * boundary but mobile-styled (full-height, ≥44px touch target). Catches render/throw failures
 * from the mobile server page + unhandled client-tree errors. No PHI surfaced — only the opaque
 * Next.js `digest` is logged as a breadcrumb.
 */

import { useEffect } from 'react';

export default function QualifyMobileError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error('Qualify (mobile) route error:', error.digest ?? 'no-digest');
  }, [error]);

  return (
    <main className="flex min-h-[100dvh] flex-col items-center justify-center gap-4 px-6 text-center">
      <h1 className="font-display text-xl font-medium tracking-tight text-ink900">Couldn’t load Qualify</h1>
      <p className="max-w-xs text-sm leading-relaxed text-ink600">
        Something went wrong. This is usually temporary.
      </p>
      <button
        type="button"
        onClick={reset}
        className="min-h-[44px] rounded-xl bg-teal900 px-5 py-2.5 text-sm font-semibold text-white"
      >
        Try again
      </button>
    </main>
  );
}
