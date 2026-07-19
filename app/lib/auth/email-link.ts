/**
 * Pure helper for the Send Email hook (app/app/api/auth-email-hook/route.ts). Lives outside the route
 * file because Next.js route modules may only export HTTP handlers + config, and because a pure leaf
 * is unit-testable without loading the route's runtime chain (repo convention).
 */

/**
 * Resolve the APP's public origin for building confirm links. We deliberately do NOT trust
 * email_data.site_url: in this project's GoTrue it arrives as the API host
 * (https://<ref>.supabase.co/auth/v1), so links built on it hit the Supabase gateway and fail with
 * "No API key found". Instead use the origin of email_data.redirect_to — inviteUser /
 * requestPasswordReset set it to `${origin}/auth/confirm?next=…`, and GoTrue defaults it to the
 * dashboard Site URL when none is passed; both are app origins, and it travels inside the
 * signature-verified payload. Fall back to VERCEL_PROJECT_PRODUCTION_URL, and as defense-in-depth
 * never return a *.supabase.co origin (the exact bug class we're fixing).
 */
export function appOrigin(redirectTo: string | undefined): string {
  const prodEnv = process.env.VERCEL_PROJECT_PRODUCTION_URL;
  const prod = prodEnv ? `https://${prodEnv.replace(/^https?:\/\//, '')}` : null;
  try {
    const origin = new URL(redirectTo ?? '').origin;
    if (origin.endsWith('.supabase.co')) return prod ?? origin;
    return origin;
  } catch {
    if (prod) return prod;
    throw new Error(
      'auth-email-hook: cannot resolve app origin (redirect_to invalid and VERCEL_PROJECT_PRODUCTION_URL unset)',
    );
  }
}

/**
 * The canonical PUBLIC origin for outbound invite links and the installed Qualify PWA's identity.
 * Invites must always point at one stable host (not the request host, which can be an ephemeral
 * preview deploy) so (a) the confirm link resolves in prod and (b) an installed PWA is always the
 * same-origin app — installing from two different hosts yields two distinct home-screen apps.
 *
 * Configurable via APP_CANONICAL_ORIGIN (host or full URL; scheme forced to https, trailing slash
 * trimmed); defaults to the ratified prod alias. Not a secret — a public URL, safe as a default.
 */
const DEFAULT_CANONICAL_ORIGIN = 'https://cmd-billing-dashboard.vercel.app';

export function canonicalAppOrigin(): string {
  const env = process.env.APP_CANONICAL_ORIGIN?.trim();
  if (!env) return DEFAULT_CANONICAL_ORIGIN;
  return `https://${env.replace(/^https?:\/\//, '')}`.replace(/\/+$/, '');
}
