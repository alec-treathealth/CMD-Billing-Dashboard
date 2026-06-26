/**
 * Public Supabase Auth config for the browser/SSR auth clients.
 *
 * Both values are PUBLIC by design: the project URL and the publishable (anon)
 * key are safe to ship to the browser (NEXT_PUBLIC_*). They are DISTINCT from
 * SUPABASE_SERVICE_ROLE_KEY and the claims_* DB URLs, which are server-only
 * secrets and must NEVER be exposed. The literal `process.env.NEXT_PUBLIC_*`
 * references below are required so Next can statically inline them into the
 * client bundle (a dynamic `process.env[name]` would not be inlined).
 */
export function supabaseUrl(): string {
  const v = process.env.NEXT_PUBLIC_SUPABASE_URL;
  if (!v || v.trim() === '') {
    throw new Error('Missing NEXT_PUBLIC_SUPABASE_URL (set it in the Next app env).');
  }
  return v;
}

export function supabaseAnonKey(): string {
  const v = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!v || v.trim() === '') {
    throw new Error('Missing NEXT_PUBLIC_SUPABASE_ANON_KEY (set it in the Next app env).');
  }
  return v;
}

/**
 * Whether the Supabase Auth env is present. Lets the middleware and the gate
 * degrade gracefully (no-op / fail-closed) BEFORE the env is configured, so adding
 * this foundation never 500s the pre-existing, non-authed routes. Once the two
 * NEXT_PUBLIC_SUPABASE_* vars are set, auth activates.
 */
export function supabaseAuthConfigured(): boolean {
  return Boolean(
    process.env.NEXT_PUBLIC_SUPABASE_URL?.trim() && process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY?.trim(),
  );
}
