/**
 * Public Supabase Auth config for the browser/SSR auth clients.
 *
 * Both values are PUBLIC by design: the project URL and the publishable (anon)
 * key are safe to ship to the browser (NEXT_PUBLIC_*). They are DISTINCT from
 * SUPABASE_SERVICE_ROLE_KEY and the claims_* DB URLs, which are server-only
 * secrets and must NEVER be exposed. The literal `process.env.NEXT_PUBLIC_*`
 * references below are required so Next can statically inline them into the
 * client bundle (a dynamic `process.env[name]` would not be inlined).
 *
 * The browser key is accepted under EITHER name: the modern
 * `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` (Supabase's current convention, and what this
 * project's Vercel env uses) OR the legacy `NEXT_PUBLIC_SUPABASE_ANON_KEY`. Both are the
 * public client key and both work as the @supabase/ssr key argument; reading both keeps
 * local dev and the deployed env working regardless of which name is set.
 */
export function supabaseUrl(): string {
  const v = process.env.NEXT_PUBLIC_SUPABASE_URL;
  if (!v || v.trim() === '') {
    throw new Error('Missing NEXT_PUBLIC_SUPABASE_URL (set it in the Next app env).');
  }
  return v;
}

export function supabaseAnonKey(): string {
  // Both literal refs are present so Next inlines whichever is set at build time.
  const v =
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
  if (!v || v.trim() === '') {
    throw new Error(
      'Missing NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY (or legacy NEXT_PUBLIC_SUPABASE_ANON_KEY).',
    );
  }
  return v;
}

/**
 * Whether the Supabase Auth env is present. Lets the middleware and the gate
 * degrade gracefully (no-op / fail-closed) BEFORE the env is configured, so adding
 * this foundation never 500s the pre-existing, non-authed routes. Once the URL + a
 * browser key (publishable or anon) are set, auth activates.
 */
export function supabaseAuthConfigured(): boolean {
  return Boolean(
    process.env.NEXT_PUBLIC_SUPABASE_URL?.trim() &&
      (process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY?.trim() ||
        process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY?.trim()),
  );
}
