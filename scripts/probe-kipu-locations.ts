/**
 * THROWAWAY READ-ONLY KIPU TOPOLOGY PROBE — NOT AN ARTIFACT. DO NOT COMMIT.
 *
 * PURPOSE: answer the one question that decides the whole Kipu ingest design —
 * **does the provisioned credential reach ONE Kipu instance containing every Treat
 * company as a location, or one instance per company?** Everything downstream (how the
 * poller is scoped to Treat_CA / Treat_WA / Treat_TX / …, whether we hold N credential
 * sets, what the LOC config looks like) forks on the answer, and no amount of reading
 * the spec produces it. Two calls do.
 *
 * IT CALLS EXACTLY TWO ENDPOINTS, BOTH NON-PHI CONFIG ROUTES:
 *   GET /api/locations    -> location_id, location_name, enabled   (the facility roster)
 *   GET /api/care_levels  -> care_level_name, hours, days_of_the_week, billable,
 *                            consider_as, selected_billing_code, locations[]
 *                            (this is the mock's hardcoded LOC_CONFIG, owned by Kipu)
 *
 * WHAT IT DOES NOT DO:
 *   - No database connection of ANY kind. Not a read, not a temp table, not a transaction.
 *   - No patient/episode/census/evaluation/group-session call. Nothing that returns PHI.
 *     `phi_level` is never sent, because neither endpoint accepts it.
 *   - No writes to Kipu. GET only. There is no POST/PATCH path in this file.
 *   - No secret, and no full app_id, ever reaches stdout.
 *
 * PHI DISCIPLINE: stdout carries facility names, level-of-care names, billing codes and
 * counts. Those are business identifiers, not patient identifiers. If a future edit makes
 * this script call an episode route, it stops being safe to run casually — write a new
 * probe instead of widening this one.
 *
 *   npx tsx --env-file=.env scripts/probe-kipu-locations.ts          # dry run, no network
 *   npx tsx --env-file=.env scripts/probe-kipu-locations.ts --live   # the two GETs
 *   npx tsx --env-file=.env scripts/probe-kipu-locations.ts --live --json
 *
 * `--env-file=.env` is REQUIRED: root scripts do not auto-load .env, and without it the
 * probe exits on missing env. `tsx` is not on PATH in this repo — go through `npx`.
 *
 * Reads KIPU_ACCESS_ID, KIPU_SECRET_KEY, and the app id from KIPU_APP_API (the name used
 * in .env today) falling back to KIPU_APP_ID. Kipu calls this value `app_id` /
 * `recipient_id`; see the naming note at the bottom of this file.
 */
import { createHmac, createHash } from 'node:crypto';

const BASE_URL = 'https://api.kipuapi.com';
const LIVE = process.argv.includes('--live');
const AS_JSON = process.argv.includes('--json');

type Creds = { accessId: string; secretKey: string; appId: string };

function creds(): Creds {
  const accessId = process.env.KIPU_ACCESS_ID;
  const secretKey = process.env.KIPU_SECRET_KEY;
  // Kipu's own name for this is app_id (aka recipient_id). .env currently spells it
  // KIPU_APP_API; accept both so this probe works before/after any rename.
  const appId = process.env.KIPU_APP_API ?? process.env.KIPU_APP_ID;
  const missing = [
    !accessId && 'KIPU_ACCESS_ID',
    !secretKey && 'KIPU_SECRET_KEY',
    !appId && 'KIPU_APP_API (or KIPU_APP_ID)',
  ].filter(Boolean);
  if (missing.length) {
    // Never echo a value — only which name is absent.
    throw new Error(`Missing env: ${missing.join(', ')} (set in .env; never hardcode or log it)`);
  }
  return { accessId: accessId!, secretKey: secretKey!, appId: appId! };
}

/**
 * The signed string and the sent string MUST be byte-identical, so the query string is
 * built ONCE as text and reused verbatim. Do not switch this to URLSearchParams at call
 * time — a reordered param is a 401, and a 401 here is never retryable.
 */
function signedGet(c: Creds, path: string, extraQuery: string[], acceptVersion: 3 | 4) {
  const query = [`app_id=${encodeURIComponent(c.appId)}`, ...extraQuery].join('&');
  const requestUri = `${path}?${query}`;
  const date = new Date().toUTCString(); // RFC 1123, e.g. "Thu, 21 Aug 2026 04:35:00 GMT"
  const canonical = `,,${requestUri},${date}`; // GET form: TWO leading commas
  const signature = createHmac('sha256', c.secretKey).update(canonical).digest('base64');
  return {
    url: BASE_URL + requestUri,
    requestUri,
    headers: {
      Accept: `application/vnd.kipusystems+json; version=${acceptVersion}`,
      Authorization: `APIAuth ${c.accessId}:${signature}`,
      Date: date,
    } as Record<string, string>,
  };
}

/**
 * A short, non-reversible fingerprint so two credential sets can be told apart across runs
 * (and compared against another integration's) WITHOUT any value reaching stdout.
 * app_id is an identifier that travels in the clear as a query param, not a secret like
 * secret_key — but it still does not belong in a shared terminal or a pasted log.
 */
function fingerprint(v: string): string {
  return `len=${v.length} last4=…${v.slice(-4)} md5_8=${createHash('md5').update(v).digest('hex').slice(0, 8)}`;
}

/** Mask the app_id value inside a request_uri before it is ever printed. */
function maskUri(uri: string): string {
  return uri.replace(/app_id=[^&]+/, 'app_id=[REDACTED]');
}

function explainStatus(status: number): string {
  if (status === 200) return 'OK';
  if (status === 401) return 'SIGNING — the signed request_uri did not match what was sent (never retry; fix the canonical string)';
  if (status === 403)
    return (
      'IDENTITY/PERMISSION — Kipu rejected the credential itself, not the URI. Three distinct causes ' +
      'look identical here: (a) the triple is mixed across API clients/instances, (b) the app_id is not ' +
      'enabled as an active API client on this instance, (c) the EMR user behind the key lacks access to ' +
      'this resource. Uniform 403s on every route point at (a) or (b); per-route 403s point at (c).'
    );
  if (status === 404) return 'BAD URI or unsupported for this method';
  if (status === 410) return 'ENDPOINT DISABLED for this Kipu instance — stop calling it';
  if (status === 422) return 'UNPROCESSABLE';
  if (status === 502) return 'Kipu is down or upgrading — back off hard';
  if (status === 503 || status === 504) return 'TRANSIENT — retry with backoff';
  return 'unexpected';
}

type LocationRow = { location_id: number; location_name: string; enabled: boolean };
type CareLevelRow = {
  care_level_id: number;
  care_level_name: string;
  hours?: string;
  billable?: string;
  consider_as?: string;
  days_of_the_week?: Record<string, string>;
  place_of_service?: string;
  selected_billing_code?: Record<string, string>;
  claim_format?: string;
  locations?: { id: number; name: string }[];
};

async function call(label: string, req: ReturnType<typeof signedGet>): Promise<unknown | null> {
  const started = Date.now();
  const res = await fetch(req.url, { method: 'GET', headers: req.headers });
  const ms = Date.now() - started;
  console.log(`\n[${label}] HTTP ${res.status} ${explainStatus(res.status)}  (${ms}ms)`);
  const text = await res.text();
  if (res.status !== 200) {
    // Error bodies from Kipu are small and non-PHI on these two config routes.
    console.log(`  body: ${text.slice(0, 400)}`);
    return null;
  }
  try {
    return JSON.parse(text);
  } catch {
    console.log(`  ⚠ non-JSON body (first 200 chars): ${text.slice(0, 200)}`);
    return null;
  }
}

async function main() {
  const c = creds();
  const appIdShape = fingerprint(c.appId);

  // NOTE: the v4 spec documents /locations with `Accept: …; version=3` (not 4) — same
  // oddity as /insurances/latest. We try 3 first, then fall back to 4, and report which
  // one the instance actually honored. That answer is worth keeping.
  const locV3 = signedGet(c, '/api/locations', ['include_buildings=false'], 3);
  const locV4 = signedGet(c, '/api/locations', ['include_buildings=false'], 4);
  const careLevels = signedGet(c, '/api/care_levels', [], 4); // app_id only; no phi_level

  console.log('=== Kipu topology probe ===');
  console.log(`mode        : ${LIVE ? 'LIVE (2–3 GETs)' : 'DRY RUN (no network)'}`);
  console.log(`access_id   : ${fingerprint(c.accessId)}`);
  console.log(`secret_key  : [set, ${c.secretKey.length} chars, not fingerprinted]`);
  console.log(`app_id      : ${appIdShape}`);
  console.log('              ▶ all three MUST come from the same Kipu API client. A triple');
  console.log('                mixed across instances authenticates as nobody → flat 403.');
  console.log(`plan        : GET ${maskUri(locV3.requestUri)}   (Accept version=3, then 4 on failure)`);
  console.log(`              GET ${maskUri(careLevels.requestUri)}   (Accept version=4)`);
  console.log('canonical   : ,,{request_uri},{RFC1123 Date}   — two leading commas, GET form');

  if (!LIVE) {
    console.log('\nDry run only. Re-run with --live to make the calls.');
    return;
  }

  let locations = (await call('locations v3', locV3)) as { locations?: LocationRow[] } | null;
  // `honored` stays null unless a call actually returned 200 — the earlier version of this
  // script reported the LAST version TRIED, which read as evidence when both had failed.
  let honoredVersion: 3 | 4 | null = locations ? 3 : null;
  if (!locations) {
    locations = (await call('locations v4', locV4)) as { locations?: LocationRow[] } | null;
    if (locations) honoredVersion = 4;
  }

  const levels = (await call('care_levels v4', careLevels)) as { care_levels?: CareLevelRow[] } | null;

  if (AS_JSON) {
    console.log('\n--- RAW JSON ---');
    console.log(JSON.stringify({ honoredVersion, locations, levels }, null, 2));
    return;
  }

  console.log('\n=== LOCATIONS (the facility roster this credential can see) ===');
  const rows = locations?.locations ?? [];
  if (!rows.length) console.log('  (none returned)');
  for (const l of rows) {
    console.log(`  ${String(l.location_id).padStart(6)}  ${l.enabled ? 'on ' : 'OFF'}  ${l.location_name}`);
  }
  console.log(
    `  total: ${rows.length} location(s); /locations Accept version honored: ` +
      `${honoredVersion ?? 'NONE — every attempt failed, so the v3-vs-v4 question is still open'}`,
  );
  console.log('  ▶ THE FORK: if the Treat companies (CA / WA / TX / NV / TN) all appear above,');
  console.log('    one instance holds them and scoping = a location_id allowlist. If only one');
  console.log('    company appears, each company is its own instance and we need one credential');
  console.log('    set (access_id + secret_key + app_id) per company.');

  console.log('\n=== CARE LEVELS (this replaces the mock\'s hardcoded LOC_CONFIG) ===');
  const lv = levels?.care_levels ?? [];
  if (!lv.length) console.log('  (none returned)');
  for (const l of lv) {
    const days = l.days_of_the_week
      ? Object.entries(l.days_of_the_week).filter(([, v]) => v && v !== 'false').map(([k]) => k).join('/')
      : '—';
    const code = l.selected_billing_code
      ? Object.entries(l.selected_billing_code).filter(([, v]) => v).map(([k, v]) => `${k}:${v}`).join(' ')
      : '—';
    const locs = l.locations?.map((x) => x.id).join(',') ?? '—';
    console.log(
      `  ${String(l.care_level_id).padStart(6)}  ${l.care_level_name}\n` +
        `          hours=${l.hours ?? '—'}  billable=${l.billable ?? '—'}  consider_as=${l.consider_as ?? '—'}\n` +
        `          days=${days}  pos=${l.place_of_service ?? '—'}  code=${code}  claim_format=${l.claim_format ?? '—'}\n` +
        `          locations=[${locs}]`,
    );
  }
  console.log(`  total: ${lv.length} care level(s)`);
  console.log('  ▶ Compare `hours` and `days_of_the_week` against the mock\'s LOC_CONFIG');
  console.log('    (capDays / minHours) and check whether "MH OP 4 Adult" resolves via');
  console.log('    `consider_as` — that is the mock\'s own ⚠ UNRESOLVED question.');
}

main().catch((err) => {
  // Never print the error object raw — a stack could carry a signed URL containing app_id.
  console.error(`probe failed: ${err instanceof Error ? err.message : 'error'}`);
  process.exit(1);
});

/*
 * NAMING NOTE (worth fixing before any real code lands):
 * .env spells this `KIPU_APP_API`, but Kipu — and every reference, client, and error
 * message you will hit — calls it `app_id` (aka `recipient_id`). A future reader greps
 * KIPU_APP_ID, finds nothing, and assumes it was never provisioned. Recommend renaming to
 * KIPU_APP_ID in .env + Vercel, or keeping both with a one-line comment in .env.example.
 *
 * ALSO: if the fork above lands on "one instance per company," the env shape has to become
 * per-company (e.g. KIPU_TREAT_CA_APP_ID / _ACCESS_ID / _SECRET_KEY) rather than one
 * global triple. Decide that BEFORE writing the poller, not after.
 */
