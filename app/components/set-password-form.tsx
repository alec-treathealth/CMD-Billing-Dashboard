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

export function SetPasswordForm({ after }: { after?: string }) {
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
      {after ? <input type="hidden" name="after" value={after} /> : null}
      <div>
        <label htmlFor="password" className="mb-1 block text-[13px] font-medium text-[#44544D]">
          New password
        </label>
        <Input
          id="password"
          name="password"
          type="password"
          autoComplete="new-password"
          required
          minLength={8}
          className="h-auto rounded-lg border-[#E5E1D6] bg-white px-3.5 py-2.5 text-sm text-[#16211C] shadow-sm focus-visible:border-[#0D5C4D] focus-visible:ring-0 focus-visible:ring-offset-0"
        />
        <p className="mt-1 text-xs text-[#75847D]">
          At least 8 characters. Pick a unique password you don’t use on other sites — passwords
          found in known data breaches are rejected.
        </p>
      </div>
      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}
      <Button
        type="submit"
        className="h-auto w-full rounded-lg bg-[#0D5C4D] py-2.5 text-sm font-semibold text-white shadow-sm hover:bg-[#0A453B]"
        disabled={submitting}
      >
        {submitting ? 'Saving…' : 'Save password'}
      </Button>
    </form>
  );
}
