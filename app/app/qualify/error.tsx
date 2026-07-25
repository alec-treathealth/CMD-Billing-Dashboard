'use client';

/**
 * Route error boundary for /qualify (desktop). Catches render/throw failures from the server page
 * (e.g. a transient dashboardAccess()/DB blip) and unhandled errors in the client tree, so users
 * get a recoverable message + Try-again instead of Next's default full-page error screen.
 * No PHI: the error text is not surfaced to the user — only Next's opaque `digest` is logged.
 */

import { useEffect } from 'react';

export default function QualifyError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    // Breadcrumb only; the digest is an opaque Next.js hash (no PHI, no query text).
    console.error('Qualify route error:', error.digest ?? 'no-digest');
  }, [error]);

  return (
    <main className="mx-auto flex min-h-[60vh] max-w-[1680px] items-center justify-center p-6 sm:p-8">
      <div className="w-full max-w-md rounded-2xl border border-line bg-card p-8 text-center shadow-ths-sm">
        <h1 className="font-display text-2xl font-medium tracking-tight text-ink900">Qualify couldn’t load</h1>
        <p className="mt-2 text-sm leading-relaxed text-ink600">
          Something went wrong loading this page. This is usually temporary — try again.
        </p>
        <button
          type="button"
          onClick={reset}
          className="mt-5 rounded-lg bg-teal900 px-4 py-2 text-sm font-semibold text-white shadow-ths-sm transition-colors hover:bg-teal700"
        >
          Try again
        </button>
      </div>
    </main>
  );
}
