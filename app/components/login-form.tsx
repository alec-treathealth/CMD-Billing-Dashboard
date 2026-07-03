'use client';

/**
 * Executive sign-in form. Posts email + password to the `signIn` Server Action,
 * which enforces the invite-only model and (on success) redirects server-side. Only the
 * generic error string ever comes back to the client — no field-level detail.
 *
 * Single error surface: `authError` is the ONE source of truth for every auth failure the
 * login page can show — the expired/consumed invite-link error (seeded from the `?error=auth`
 * URL param via `initialError`) AND a failed sign-in ("Invalid credentials."). Because it is a
 * single nullable value, the two can never accumulate: a new failure replaces the old one. It
 * is cleared on any field change and at submit-start, and once an error is seeded from the URL
 * we strip the param so a refresh can't resurrect a stale error.
 */
import * as React from 'react';
import { useRouter } from 'next/navigation';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { signIn } from '@/lib/auth-actions';

export function LoginForm({
  next,
  initialError = null,
}: {
  next: string;
  initialError?: string | null;
}) {
  const router = useRouter();
  const [authError, setAuthError] = React.useState<string | null>(initialError);
  const [submitting, setSubmitting] = React.useState(false);

  // If we seeded an error from the `?error=auth` URL param, strip it from the URL (once, on
  // mount) so a page refresh doesn't resurrect a stale error. The message stays in component
  // state — this only cleans the address bar, it does not clear the visible alert. `next` is
  // already captured in the hidden field below, so dropping it from the URL is harmless (and
  // `?error=auth` and `?next=` never co-occur: the confirm route redirects with error only).
  React.useEffect(() => {
    if (initialError) router.replace('/login');
    // Intentionally mount-only: we do not want to react to later prop changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setAuthError(null);
    setSubmitting(true);
    const formData = new FormData(e.currentTarget);
    try {
      // On success the action redirects (navigation); only failures return here.
      const result = await signIn(formData);
      if (result?.error) setAuthError(result.error);
    } catch {
      setAuthError('Something went wrong. Please try again.');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form
      onSubmit={onSubmit}
      onChange={() => setAuthError(null)}
      className="space-y-4"
      noValidate
    >
      <input type="hidden" name="next" value={next} />
      {authError ? (
        <div
          role="alert"
          aria-live="assertive"
          className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive"
        >
          {authError}
        </div>
      ) : null}
      <div className="space-y-1.5">
        <label htmlFor="email" className="text-sm font-medium">
          Work email
        </label>
        <Input
          id="email"
          name="email"
          type="email"
          autoComplete="username"
          required
          placeholder="you@treathealth.ai"
        />
      </div>
      <div className="space-y-1.5">
        <label htmlFor="password" className="text-sm font-medium">
          Password
        </label>
        <Input
          id="password"
          name="password"
          type="password"
          autoComplete="current-password"
          required
        />
      </div>
      <Button type="submit" className="w-full" disabled={submitting}>
        {submitting ? 'Signing in…' : 'Sign in'}
      </Button>
    </form>
  );
}
