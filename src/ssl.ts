/**
 * TLS verify-full configuration for every node-postgres pool (claims_admin and
 * claims_reader) — Phase 3 SSL hardening.
 *
 * Previously the pools connected with `ssl: { rejectUnauthorized: false }`: TLS
 * was on (encrypted in transit) but the server certificate was NOT verified, so
 * the connection was not proof against an active MITM. This module supplies the
 * Supabase Root CA so node verifies the pooler's certificate chain AND its
 * hostname (`rejectUnauthorized: true`) — i.e. sslmode=verify-full.
 *
 * The CA lives at certs/supabase-ca.crt — COMMITTED to the repo (not gitignored).
 * It is the self-signed "Supabase Root 2021 CA" that anchors the pooler's
 * leaf -> intermediate -> root chain; a root CA is a PUBLIC certificate, not a
 * secret, so committing it is safe.
 *
 * On Vercel (and any webpack-bundled Next.js context) the preferred path is to
 * set the SUPABASE_CA_PEM environment variable to the cert content: webpack
 * replaces import.meta.url with the compiled chunk's URL (not the source file),
 * so the file-based path below resolves to the wrong location at runtime. The env
 * var is always tried first; the file-based fallback is used in raw Node.js ESM
 * (local dev, CLI scripts, tests that exercise ssl.ts directly).
 *
 * NOTE: CA_PATH is NOT computed at module load time — doing so would call
 * fileURLToPath during Next.js's "collecting page data" build phase, where
 * webpack's cross-realm URL object fails Node's instanceof URL check and throws
 * ERR_INVALID_ARG_TYPE. The path is computed lazily inside supabaseCa() so it
 * is only evaluated when an actual DB connection is opened (never at build time).
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

let cachedCa: string | undefined;

/** Read (and cache) the Supabase Root CA. Throws a clear error if it's missing. */
export function supabaseCa(): string {
  if (cachedCa !== undefined) return cachedCa;

  // Preferred on Vercel: set SUPABASE_CA_PEM to the content of certs/supabase-ca.crt.
  // It is a public root CA (not a secret), safe to store as an env var.
  const fromEnv = process.env.SUPABASE_CA_PEM;
  if (fromEnv && fromEnv.trim()) {
    cachedCa = fromEnv.trim();
    return cachedCa;
  }

  // Fallback: read from the committed file. Pass .href (string) to fileURLToPath to
  // avoid cross-realm URL instanceof failures in webpack-bundled code.
  const caPath = fileURLToPath(new URL('../certs/supabase-ca.crt', import.meta.url).href);
  try {
    cachedCa = readFileSync(caPath, 'utf8');
  } catch {
    throw new Error(
      `Missing Supabase CA cert. ` +
        `Set SUPABASE_CA_PEM env var (Vercel) or commit certs/supabase-ca.crt (local). ` +
        `Tried file path: ${caPath}`,
    );
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
