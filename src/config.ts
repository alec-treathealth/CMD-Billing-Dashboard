/**
 * Environment-driven config. Secrets come from env ONLY — never hardcoded,
 * never logged. The three sheet IDs are canonical identifiers (not secrets) and
 * are pinned here from CLAUDE.md; per the spec's warning we NEVER substitute
 * the near-identical "Historical Data for ..." copies.
 *
 * Phase 2 / Decision 1: the ingest connects to Postgres as the least-privilege
 * `claims_admin` role via CLAIMS_ADMIN_DATABASE_URL (node-postgres) — the
 * service-role key and SUPABASE_URL are no longer on the loader path.
 *
 * Google auth is NOT in env — it uses the OAuth installed-app flow in auth.ts
 * (secrets/oauth-client.json + secrets/token.json).
 */
import { z } from 'zod';
import type { SheetSource } from './types.js';

/** Canonical sources — the "Copy of" set in "Reports for Alec AI". */
export const SHEET_SOURCES: readonly SheetSource[] = [
  { year: 2024, sheetId: '1BE3d6lzaopaWNQXUUrP1_yLs21uwYG2LNQBDjqzK2Ic', tab: 'Sheet1' },
  { year: 2025, sheetId: '1FMXHl4b57IPp2jlMsatmkfZHYmq-HfVBQXJrzWjtlOg', tab: 'Sheet1' },
  { year: 2026, sheetId: '1GQrOoQUhf5JgWrjnHXl-iJ28ZZzrM-9CEt-X7UiC8pc', tab: 'Sheet1' },
];

const EnvSchema = z.object({
  // postgresql://claims_admin:<pw>@<host>:5432/postgres?sslmode=require
  CLAIMS_ADMIN_DATABASE_URL: z.string().url('CLAIMS_ADMIN_DATABASE_URL must be a Postgres URL'),
});

export interface AppConfig {
  claimsAdminDatabaseUrl: string;
}

/**
 * Parse + validate env. Throws a redacted error (names only, never values) so a
 * misconfig can't leak a secret into logs.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = EnvSchema.safeParse(env);
  if (!parsed.success) {
    const missing = parsed.error.issues.map((i) => i.path.join('.')).join(', ');
    throw new Error(`Invalid environment config (check, do not log, these vars): ${missing}`);
  }
  return {
    claimsAdminDatabaseUrl: parsed.data.CLAIMS_ADMIN_DATABASE_URL,
  };
}
