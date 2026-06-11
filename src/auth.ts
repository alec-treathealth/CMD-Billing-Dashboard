/**
 * Google OAuth installed-app (loopback) auth — replaces service-account keys,
 * which org policy `iam.disableServiceAccountKeyCreation` forbids.
 *
 * Scope is read-only Sheets ONLY. Client config is read from
 * ./secrets/oauth-client.json. The first run performs a one-time consent and
 * persists the refresh token to ./secrets/token.json; subsequent runs load and
 * silently refresh from it (no browser). Both files are secrets and live under
 * the gitignored secrets/ directory — never logged, never committed.
 */
import { exec } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { google } from 'googleapis';
import type { OAuth2Client } from 'google-auth-library';

const SECRETS_DIR = 'secrets';
const CLIENT_PATH = join(SECRETS_DIR, 'oauth-client.json');
const TOKEN_PATH = join(SECRETS_DIR, 'token.json');
const SCOPES = ['https://www.googleapis.com/auth/spreadsheets.readonly'];
const REDIRECT_PORT = Number(process.env.OAUTH_REDIRECT_PORT ?? 53682);
const REDIRECT_URI = `http://localhost:${REDIRECT_PORT}`;

interface OAuthClientConfig {
  client_id: string;
  client_secret: string;
}

function readClientConfig(): OAuthClientConfig {
  if (!existsSync(CLIENT_PATH)) {
    throw new Error(
      `Missing ${CLIENT_PATH}. Download the OAuth client (type: Desktop app) ` +
        `from Google Cloud Console and save it there. It is gitignored.`,
    );
  }
  const parsed = JSON.parse(readFileSync(CLIENT_PATH, 'utf8')) as {
    installed?: OAuthClientConfig;
    web?: OAuthClientConfig;
  };
  const cfg = parsed.installed ?? parsed.web;
  if (!cfg?.client_id || !cfg?.client_secret) {
    throw new Error(`${CLIENT_PATH} is not a valid OAuth client (missing client_id/client_secret).`);
  }
  return { client_id: cfg.client_id, client_secret: cfg.client_secret };
}

/** Wait for the OAuth redirect on the loopback server and return the auth code. */
function waitForCode(authUrl: string): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const server = createServer((req, res) => {
      try {
        const url = new URL(req.url ?? '', REDIRECT_URI);
        const error = url.searchParams.get('error');
        const code = url.searchParams.get('code');
        if (error) {
          res.end(`Authorization failed: ${error}. You can close this tab.`);
          server.close();
          reject(new Error(`OAuth consent denied: ${error}`));
          return;
        }
        if (!code) {
          res.statusCode = 400;
          res.end('Missing authorization code. You can close this tab.');
          return;
        }
        res.end('Authorization complete. You can close this tab and return to the terminal.');
        server.close();
        resolve(code);
      } catch (e) {
        server.close();
        reject(e instanceof Error ? e : new Error('loopback handler error'));
      }
    });
    server.on('error', reject);
    server.listen(REDIRECT_PORT, () => {
      console.log('\n[auth] Open this URL to grant read-only Sheets access:\n');
      console.log(`  ${authUrl}\n`);
      // Best-effort auto-open on macOS; ignore failures (URL is printed above).
      exec(`open ${JSON.stringify(authUrl)}`, () => {});
    });
  });
}

/** One-time consent: get a refresh token and persist it (owner-only perms). */
async function runConsent(client: OAuth2Client): Promise<void> {
  const authUrl = client.generateAuthUrl({
    access_type: 'offline',
    scope: SCOPES,
    prompt: 'consent', // force a refresh_token even on re-grant
  });
  const code = await waitForCode(authUrl);
  const { tokens } = await client.getToken(code);
  if (!tokens.refresh_token) {
    throw new Error(
      'No refresh_token returned. Revoke the prior grant at ' +
        'https://myaccount.google.com/permissions and re-run to consent again.',
    );
  }
  client.setCredentials(tokens);
  writeFileSync(TOKEN_PATH, `${JSON.stringify({ refresh_token: tokens.refresh_token }, null, 2)}\n`, {
    mode: 0o600,
  });
  console.log(`[auth] Refresh token saved to ${TOKEN_PATH} (gitignored).`);
}

/**
 * Return an authenticated OAuth2 client. Uses the stored refresh token if
 * present (silent), otherwise runs the one-time consent flow.
 */
export async function getOAuthClient(): Promise<OAuth2Client> {
  const cfg = readClientConfig();
  const client = new google.auth.OAuth2(cfg.client_id, cfg.client_secret, REDIRECT_URI);

  if (existsSync(TOKEN_PATH)) {
    const saved = JSON.parse(readFileSync(TOKEN_PATH, 'utf8')) as { refresh_token?: string };
    if (!saved.refresh_token) {
      throw new Error(`${TOKEN_PATH} has no refresh_token. Delete it and re-run to consent again.`);
    }
    client.setCredentials({ refresh_token: saved.refresh_token });
    // The google client library auto-refreshes the access token on demand.
    return client;
  }

  console.log('[auth] No token.json found — starting one-time consent (read-only Sheets)…');
  await runConsent(client);
  return client;
}
