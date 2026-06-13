/**
 * TLS verify-full configuration for every node-postgres pool (claims_admin and
 * claims_reader) — Phase 3 SSL hardening.
 *
 * Previously the pools connected with `ssl: { rejectUnauthorized: false }`: TLS
 * was on (encrypted in transit) but the server certificate was NOT verified, so
 * the connection was not proof against an active MITM. This module supplies the
 * Supabase Root 2021 CA so node verifies the pooler's certificate chain AND its
 * hostname (`rejectUnauthorized: true`) — i.e. sslmode=verify-full.
 *
 * The CA lives at certs/supabase-ca.crt — COMMITTED to the repo (not gitignored).
 * It is the self-signed "Supabase Root 2021 CA" that anchors the pooler's
 * leaf -> intermediate -> root chain; a root CA is a PUBLIC certificate, not a
 * secret, so committing it is safe and is what lets the Vercel deploy (and CI)
 * resolve it — `secrets/` is gitignored and would never reach the bundle. Both
 * the root tooling (admin pool in db.ts) and the Next.js app (reader pool in
 * queries/executor.ts) read it through here. Resolved relative to this file so it
 * works regardless of cwd.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const CA_PATH = fileURLToPath(new URL('../certs/supabase-ca.crt', import.meta.url));

let cachedCa: string | undefined;

/** Read (and cache) the Supabase Root CA. Throws a clear error if it's missing. */
export function supabaseCa(): string {
  if (cachedCa === undefined) {
    try {
      cachedCa = readFileSync(CA_PATH, 'utf8');
    } catch {
      throw new Error(
        `Missing Supabase CA cert at ${CA_PATH}. It should be committed at ` +
          'certs/supabase-ca.crt (see CLAUDE.md SSL hardening note).',
      );
    }
  }
  return cachedCa;
}

/**
 * The `ssl` option for a verify-full pg pool: verify the chain against the
 * Supabase Root CA and check the hostname.
 */
export function verifyFullSsl(): { rejectUnauthorized: true; ca: string } {
  return { rejectUnauthorized: true, ca: supabaseCa() };
}
