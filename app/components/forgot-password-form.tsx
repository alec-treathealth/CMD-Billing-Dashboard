'use client';

/**
 * Forgot-password form. Posts the email to the `requestPasswordReset` Server Action, which
 * sends a recovery email and always redirects to a neutral notice (no account enumeration);
 * only validation failures return here.
 */
import * as React from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { requestPasswordReset } from '@/lib/auth-actions';

export function ForgotPasswordForm() {
  const [error, setError] = React.useState<string | null>(null);
  const [submitting, setSubmitting] = React.useState(false);

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    const formData = new FormData(e.currentTarget);
    try {
      // On success the action redirects (navigation); only failures return here.
      const result = await requestPasswordReset(formData);
      if (result?.error) setError(result.error);
    } catch {
      setError('Something went wrong. Please try again.');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form onSubmit={onSubmit} className="space-y-4" noValidate>
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
      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}
      <Button type="submit" className="w-full" disabled={submitting}>
        {submitting ? 'Sending…' : 'Send reset link'}
      </Button>
    </form>
  );
}
