/**
 * Pure mapper: turn a Supabase updateUser({ password }) failure into a user-facing message.
 *
 * GoTrue rejects passwords that fail the project's policy with HTTP 422 / code 'weak_password',
 * carrying a `reasons` array of ("length" | "characters" | "pwned"). This project has leaked-password
 * (Pwned Passwords) protection enabled, so the common rejection is `pwned` — a password found in a
 * known data breach. We surface the specific reason instead of a dead-end generic error.
 *
 * Kept as a pure leaf (no Supabase/runtime imports) so it's unit-testable and reusable — the caller
 * passes the plain code/status/reasons off the AuthError.
 */
export function passwordUpdateErrorMessage(input: {
  code?: string;
  status?: number;
  reasons?: string[];
}): string {
  const reasons = input.reasons ?? [];
  const isWeak = input.code === 'weak_password' || input.status === 422 || reasons.length > 0;
  if (!isWeak) {
    return 'Could not set your password. Please try again.';
  }
  if (reasons.includes('pwned')) {
    return 'That password appears in a known data breach. Choose a unique password you don’t use on any other site.';
  }
  if (reasons.includes('length') || reasons.includes('characters')) {
    return 'That password doesn’t meet the requirements. Use at least 8 characters and avoid common words or patterns.';
  }
  return 'That password can’t be used — it may be too common or appear in a known data breach. Choose a longer, unique password you don’t use elsewhere.';
}
