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
import path from 'node:path';

let cachedCa: string | undefined;

/**
 * Read (and cache) the Supabase CA bundle. Resolution order (first hit wins):
 *   1. SUPABASE_CA_PEM   — the full PEM as an env var (preferred on Vercel).
 *   2. SUPABASE_CA_PATH  — absolute path to the cert file (escape hatch for envs
 *                          where the PEM string can't be set reliably).
 *   3. process.cwd()/certs/supabase-ca.crt — reliable on Vercel serverless (the
 *                          function cwd is the project root where certs/ is bundled).
 *   4. import.meta.url-relative path — last resort; correct in raw Node ESM (local
 *                          dev, CLI, tests), but webpack rewrites import.meta.url to
 *                          the compiled chunk's location on Vercel, so it can miss.
 * Each file path is tried independently (try/catch); we only throw once all are
 * exhausted. The path LABEL that succeeded is logged (never the cert content).
 */
export function supabaseCa(): string {
  if (cachedCa !== undefined) return cachedCa;

  // 1. SUPABASE_CA_PEM — public root CA (not a secret), safe to store as an env var.
  const fromEnv = process.env.SUPABASE_CA_PEM;
  if (fromEnv && fromEnv.trim()) {
    cachedCa = fromEnv.trim();
    console.log('ssl: loaded CA from SUPABASE_CA_PEM env var');
    return cachedCa;
  }

  // File-based fallbacks, in priority order. resolve() is a thunk so a path-computation
  // throw (e.g. fileURLToPath cross-realm failure in webpack-bundled code) is caught and
  // we move to the next candidate rather than aborting the whole resolution.
  const candidates: Array<{ label: string; resolve: () => string }> = [];

  const fromPath = process.env.SUPABASE_CA_PATH?.trim();
  if (fromPath) candidates.push({ label: 'SUPABASE_CA_PATH', resolve: () => fromPath });

  candidates.push({ label: 'cwd', resolve: () => path.join(process.cwd(), 'certs', 'supabase-ca.crt') });
  candidates.push({
    label: 'import.meta.url',
    resolve: () => fileURLToPath(new URL('../certs/supabase-ca.crt', import.meta.url).href),
  });

  const tried: string[] = [];
  for (const { label, resolve } of candidates) {
    let caPath: string;
    try {
      caPath = resolve();
    } catch {
      tried.push(`${label}=<unresolved>`);
      continue;
    }
    tried.push(`${label}=${caPath}`);
    try {
      cachedCa = readFileSync(caPath, 'utf8');
      console.log(`ssl: loaded CA from ${label} path`);
      return cachedCa;
    } catch {
      // file missing/unreadable at this path — try the next candidate
    }
  }

  throw new Error(
    `Missing Supabase CA cert. Set SUPABASE_CA_PEM (full PEM) or SUPABASE_CA_PATH ` +
      `(absolute path), or commit certs/supabase-ca.crt (local). Tried: ${tried.join(', ')}`,
  );
}

/**
 * The `ssl` option for a verify-full pg pool: verify the chain against the
 * Supabase Root CA and check the hostname.
 */
export function verifyFullSsl(): { rejectUnauthorized: true; ca: string } {
  return { rejectUnauthorized: true, ca: supabaseCa() };
}
