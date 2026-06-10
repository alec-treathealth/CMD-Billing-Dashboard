/**
 * Environment-driven config. Secrets come from env ONLY — never hardcoded,
 * never logged. The three sheet IDs are canonical identifiers (not secrets) and
 * are pinned here from CLAUDE.md; per the spec's warning we NEVER substitute
 * the near-identical "Historical Data for ..." copies.
 */
import { readFileSync } from 'node:fs';
import { google } from 'googleapis';
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
  GOOGLE_APPLICATION_CREDENTIALS: z.string().min(1).optional(),
  GOOGLE_SERVICE_ACCOUNT_JSON: z.string().min(1).optional(),
});

export interface AppConfig {
  supabaseUrl: string;
  supabaseServiceRoleKey: string;
  googleCredentials: { client_email: string; private_key: string };
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
  const e = parsed.data;

  const credsJson = e.GOOGLE_SERVICE_ACCOUNT_JSON
    ? e.GOOGLE_SERVICE_ACCOUNT_JSON
    : e.GOOGLE_APPLICATION_CREDENTIALS
      ? readFileSync(e.GOOGLE_APPLICATION_CREDENTIALS, 'utf8')
      : undefined;
  if (!credsJson) {
    throw new Error(
      'Google credentials missing: set GOOGLE_SERVICE_ACCOUNT_JSON or GOOGLE_APPLICATION_CREDENTIALS.',
    );
  }

  let creds: { client_email?: string; private_key?: string };
  try {
    creds = JSON.parse(credsJson);
  } catch {
    throw new Error('Google credentials are not valid JSON (value not logged).');
  }
  if (!creds.client_email || !creds.private_key) {
    throw new Error('Google credentials JSON missing client_email/private_key (value not logged).');
  }

  return {
    supabaseUrl: e.SUPABASE_URL,
    supabaseServiceRoleKey: e.SUPABASE_SERVICE_ROLE_KEY,
    googleCredentials: { client_email: creds.client_email, private_key: creds.private_key },
  };
}

/** Build a read-only Google auth client (least privilege). */
export function googleAuth(creds: AppConfig['googleCredentials']) {
  return new google.auth.JWT({
    email: creds.client_email,
    key: creds.private_key,
    scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly'],
  });
}
