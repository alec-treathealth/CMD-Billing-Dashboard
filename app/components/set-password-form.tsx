'use client';

/**
 * Set-password form. Posts the new password to the `setPassword` Server Action, which calls
 * supabase.auth.updateUser on the session established by the invite/recovery link (or an
 * existing login). On success the action redirects; only failures return here.
 */
import * as React from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { setPassword } from '@/lib/auth-actions';

export function SetPasswordForm() {
  const [error, setError] = React.useState<string | null>(null);
  const [submitting, setSubmitting] = React.useState(false);

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    const formData = new FormData(e.currentTarget);
    try {
      // On success the action redirects (navigation); only failures return here.
      const result = await setPassword(formData);
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
        <label htmlFor="password" className="text-sm font-medium">
          New password
        </label>
        <Input
          id="password"
          name="password"
          type="password"
          autoComplete="new-password"
          required
          minLength={8}
        />
        <p className="text-xs text-ink400">At least 8 characters.</p>
      </div>
      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}
      <Button type="submit" className="w-full" disabled={submitting}>
        {submitting ? 'Saving…' : 'Save password'}
      </Button>
    </form>
  );
}
