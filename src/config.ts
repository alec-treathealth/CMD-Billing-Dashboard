/**
 * Environment-driven config. Secrets come from env ONLY — never hardcoded,
 * never logged. The three sheet IDs are canonical identifiers (not secrets) and
 * are pinned here from CLAUDE.md; per the spec's warning we NEVER substitute
 * the near-identical "Historical Data for ..." copies.
 *
 * Google auth is NOT in env — it uses the OAuth installed-app flow in auth.ts
 * (secrets/oauth-client.json + secrets/token.json). Only Supabase is here.
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
  SUPABASE_URL: z.string().url(),
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(1, 'SUPABASE_SERVICE_ROLE_KEY is required'),
});

export interface AppConfig {
  supabaseUrl: string;
  supabaseServiceRoleKey: string;
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
    supabaseUrl: parsed.data.SUPABASE_URL,
    supabaseServiceRoleKey: parsed.data.SUPABASE_SERVICE_ROLE_KEY,
  };
}
