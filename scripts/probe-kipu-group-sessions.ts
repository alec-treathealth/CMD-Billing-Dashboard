/**
 * READ-ONLY KIPU DIAGNOSTIC — `GET /api/group_sessions`. One question, asked live.
 *
 * WHY THIS FILE EXISTS. `/api/group_sessions` is the single untested dependency of the
 * whole Billable Days ingest, and two prior sessions left exactly one fork open:
 *
 *   - 200 with the BILLING FIELDS POPULATED -> the planned ingest works as designed.
 *   - 200 with them EMPTY  -> the same hole `/api/care_levels` turned out to have (hours,
 *     days_of_the_week, selected_billing_code and billable came back empty on all 9 care
 *     levels; only `consider_as` was populated). The data contract has a gap and the
 *     design changes.
 *   - 410 -> the endpoint is DISABLED for this instance and the feature cannot be built
 *     the planned way at all.
 *
 * A status code alone does not separate those. This probe reports the SHAPE of a 200 —
 * which fields are present and which are present-but-empty — because that is the actual
 * question, and it is the one `/api/care_levels` answered wrong when read as "200 = fine".
 *
 * ⚠ THIS ROUTE IS PHI-BEARING AND IS TREATED AS SUCH. Every session carries
 * `episodes[] { episode_id, present, note, session_start_time }`. An `episode_id` is a
 * patient-linked identifier, and `note` is free text a clinician wrote about a patient.
 * NEITHER EVER REACHES STDOUT. The probe reports episode COUNTS and present/absent
 * TALLIES only, and never reads `note` at all. The session-level fields it does print —
 * title, topic, billing codes, place_of_service, billable, times — are billing
 * configuration, the same class of value the sibling probe prints for care levels.
 *
 * ⚠ NON-200 BODIES ARE WITHHELD AT EVERY STATUS, same discipline as `censusScopeCheck`
 * in the sibling probe. A status code is not evidence about a body's CONTENTS: a 4xx/5xx
 * from a PHI-bearing route can echo a query, an upstream trace, or a partial payload. The
 * body is decoded into a local, matched against the sibling's fixed `KNOWN_KIPU_ERRORS`
 * allowlist, and discarded — only the matched LABEL and the byte LENGTH are printed. Do
 * not reintroduce a print of the body at any status.
 *
 * IT REUSES THE SIBLING'S SIGNER — it does not define a second one. `kipuSignature` /
 * `kipuCanonicalString` are pinned bit-for-bit by the hermetic `test/kipuSignature.test.ts`
 * against Kipu's published worked example; a second copy here would be a second thing to
 * drift. Auth is `APIAuth-HMAC-SHA256` (the scheme prefix selects the digest server-side;
 * bare `APIAuth` means SHA-1 and fails every time).
 *
 * OUTSIDE THE FIVE-COMMAND GATE, deliberately: it makes live third-party network calls, so
 * it can never run in `npm test`.
 *
 * CALL BUDGET — AT MOST 3 GETs, no retries. "No sessions" and "endpoint broken" are
 * different answers, so the windows ESCALATE and stop at the first non-empty result:
 *   1. one recent full Mon-Sun week, scoped to --location
 *   2. the same week widened to four weeks, same location
 *   3. four weeks with NO location_id — the control that separates "this location ran no
 *      groups" from "this route returns nothing for anybody"
 *
 * GET only. No writes to Kipu, no database connection of any kind.
 *
 *   npx tsx --env-file=.env scripts/probe-kipu-group-sessions.ts           # dry run, no network
 *   npx tsx --env-file=.env scripts/probe-kipu-group-sessions.ts --live
 *   npx tsx --env-file=.env scripts/probe-kipu-group-sessions.ts --live --location=105
 *   npx tsx --env-file=.env scripts/probe-kipu-group-sessions.ts --live --week=2026-08-17
 *
 * `--env-file=.env` is REQUIRED: root scripts do not auto-load .env. `tsx` is not on PATH.
 */
// ⚠ `.js`, NOT `.ts`, even though the file on disk is `.ts`. Root `tsc` runs NodeNext
// resolution and rejects a `.ts` import specifier outright (TS5097) unless
// `allowImportingTsExtensions` is on, which it is not — and root tsc is stricter than
// app tsc, so this fails the gate at the root even when everything else is green. `tsx`
// resolves the `.js` specifier back to the `.ts` source at runtime. Same convention as
// the rest of the repo (see `src/kipu/locations.ts` importing `../tenants.js`).
import {
  creds,
  signedUri,
  maskUri,
  fingerprint,
  explainStatus,
  classifyKnownError,
  type Creds,
} from './probe-kipu-locations.js';

const LIVE = process.argv.includes('--live');

function argValue(name: string): string | undefined {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : undefined;
}

/**
 * Default location 2 = "Treat Mental Health Texas", read from the live /api/locations
 * roster on 2026-08-30. Texas is the densest OP/IOP label family in the nine-export
 * corpus (`TX Group Session`, `Scott & Jenny Group Session TX`, `Telehealth MH TX Group
 * Sessions` all map through it), so it is the location most likely to have run groups in
 * any given week — which is what makes an EMPTY result from it informative rather than
 * merely uninteresting.
 */
const DEFAULT_LOCATION = '2';

/** Monday of the most recent COMPLETE Mon-Sun week, in UTC calendar terms. */
function lastCompleteMonday(today: Date): string {
  const d = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate()));
  // getUTCDay: 0=Sun. Days back to this week's Monday, then one more week for the last COMPLETE one.
  const backToMonday = (d.getUTCDay() + 6) % 7;
  d.setUTCDate(d.getUTCDate() - backToMonday - 7);
  return d.toISOString().slice(0, 10);
}

function addDays(iso: string, n: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/* ────────────────────────── the shape report ────────────────────────── */

/**
 * The billing fields the ingest actually depends on. `/api/care_levels` returned 200 with
 * its equivalents EMPTY, which is why presence is counted per field rather than assumed
 * from the status code.
 */
const BILLING_FIELDS = [
  'billable',
  'billing_codes',
  'selected_billing_code',
  'place_of_service',
  'billable_claim_format',
  'ancillary',
  'status',
] as const;

const IDENTITY_FIELDS = [
  'session_start_time',
  'session_end_time',
  'group_session_title',
  'group_session_topic',
  'group_leader_full_name',
  'location_id',
] as const;

/**
 * Is a value PRESENT in the sense that matters here? `null`, `undefined`, `''`, `[]` and
 * `{}` all count as ABSENT — the care_levels hole was exactly an empty object/string
 * arriving where a value was expected, and a naive `!== undefined` check reported it as
 * populated. `false` and `0` are PRESENT: `billable: false` is a real answer.
 */
function isPopulated(v: unknown): boolean {
  if (v === null || v === undefined) return false;
  if (typeof v === 'string') return v.trim().length > 0;
  if (Array.isArray(v)) return v.length > 0;
  if (typeof v === 'object') return Object.values(v as Record<string, unknown>).some(isPopulated);
  return true;
}

/** A compact, NON-PHI description of a value. Strings are shown; they are billing config. */
function describe(v: unknown): string {
  if (v === null) return 'null';
  if (v === undefined) return '(absent)';
  if (typeof v === 'string') return v.length ? JSON.stringify(v.slice(0, 60)) : "'' (EMPTY)";
  if (Array.isArray(v)) return v.length ? `[${v.length} item(s)]` : '[] (EMPTY)';
  if (typeof v === 'object') {
    const e = Object.entries(v as Record<string, unknown>).filter(([, x]) => isPopulated(x));
    return e.length ? `{${e.map(([k, x]) => `${k}=${String(x).slice(0, 24)}`).join(' ')}}` : '{} (EMPTY)';
  }
  return String(v);
}

interface WindowResult {
  label: string;
  status: number;
  sessionCount: number | null;
  transportError?: boolean;
}

/**
 * Locate the session array inside an unknown envelope. Kipu's envelope key is not
 * confirmed against a live response anywhere in this repo, so it is DISCOVERED rather
 * than assumed — the top-level keys are printed either way, so a wrong guess is visible
 * instead of silently reading as "zero sessions".
 */
function findSessions(body: unknown): { key: string; rows: Record<string, unknown>[] } | null {
  if (!body || typeof body !== 'object') return null;
  for (const [k, v] of Object.entries(body as Record<string, unknown>)) {
    if (Array.isArray(v)) return { key: k, rows: v as Record<string, unknown>[] };
    if (v && typeof v === 'object') {
      const nested = findSessions(v);
      if (nested) return { key: `${k}.${nested.key}`, rows: nested.rows };
    }
  }
  return null;
}

async function probeWindow(
  c: Creds,
  label: string,
  startDate: string,
  endDate: string,
  locationId: string | null,
): Promise<WindowResult> {
  // The signed string and the sent string must be byte-identical, so the query text is
  // owned verbatim here — including its parameter ORDER. Do not switch to URLSearchParams.
  const parts = [
    `app_id=${encodeURIComponent(c.appId)}`,
    `session_start_date=${startDate}`,
    `session_end_date=${endDate}`,
  ];
  if (locationId !== null) parts.push(`location_id=${encodeURIComponent(locationId)}`);
  parts.push('page=1', 'per=100');
  const req = signedUri(c, `/api/group_sessions?${parts.join('&')}`, 4);

  console.log(`\n──────── ${label} ────────`);
  console.log(`  window : ${startDate} .. ${endDate}   location_id=${locationId ?? '(none — global control)'}`);
  console.log(`  uri    : ${maskUri(req.requestUri)}`);

  const t0 = Date.now();
  let status = 0;
  let raw: ArrayBuffer;
  try {
    const res = await fetch(req.url, { method: 'GET', headers: req.headers });
    status = res.status;
    raw = await res.arrayBuffer();
  } catch (e) {
    // A transport failure is NOT a verdict — flag it so two failures never compare equal.
    console.log(`  status : n/a (transport error: ${e instanceof Error ? e.message : 'unknown'})`);
    return { label, status: 0, sessionCount: null, transportError: true };
  }
  const ms = Date.now() - t0;
  console.log(`  status : HTTP ${status} ${explainStatus(status)}   (${ms}ms, ${raw.byteLength} bytes)`);

  if (status !== 200) {
    // ⚠ PHI-BEARING ROUTE: decode into a LOCAL, classify against the fixed allowlist,
    // discard. Only the matched label is printed. An unrecognised body prints nothing
    // about its contents — the allowlist can only ever confirm a string we already knew.
    const known = classifyKnownError(new TextDecoder().decode(raw));
    console.log(`  body   : [WITHHELD — PHI-bearing route] ${known ? `matched: ${known}` : 'unrecognised (contents not printed)'}`);
    return { label, status, sessionCount: null };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(raw));
  } catch {
    console.log('  ⚠ 200 but the body is not JSON. Contents withheld (PHI-bearing route).');
    return { label, status, sessionCount: null };
  }

  console.log(`  top-level keys: ${Object.keys(parsed as object).join(', ') || '(none)'}`);
  // Pagination is COUNTS ONLY — non-PHI, and it is the only thing that says whether page 1
  // is the whole window. `per=100` against 16 rows LOOKS complete, but "looks complete" is
  // an inference and the envelope is evidence.
  const pg = (parsed as Record<string, unknown>)['pagination'];
  if (pg && typeof pg === 'object') console.log(`  pagination    : ${JSON.stringify(pg)}`);
  const found = findSessions(parsed);
  if (!found) {
    console.log('  ⚠ 200 but NO array anywhere in the envelope — zero sessions and no list to read.');
    return { label, status, sessionCount: 0 };
  }
  console.log(`  session array : "${found.key}"  ->  ${found.rows.length} session(s)`);
  if (found.rows.length === 0) return { label, status, sessionCount: 0 };

  reportShape(found.rows);
  return { label, status, sessionCount: found.rows.length };
}

/** The actual deliverable: which fields arrived, and which arrived EMPTY. */
function reportShape(rows: Record<string, unknown>[]): void {
  const n = rows.length;
  const allKeys = new Set<string>();
  for (const r of rows) for (const k of Object.keys(r)) allKeys.add(k);

  console.log(`\n  ═══ FIELD PRESENCE across all ${n} session(s) ═══`);
  console.log(`  keys returned : ${[...allKeys].sort().join(', ')}`);

  const tally = (field: string) => {
    const present = rows.filter((r) => field in r).length;
    const populated = rows.filter((r) => isPopulated(r[field])).length;
    const verdict =
      present === 0 ? 'ABSENT — key not returned at all'
      : populated === 0 ? '⚠ PRESENT BUT EMPTY ON EVERY ROW — the care_levels hole'
      : populated === n ? 'populated on every row'
      : `populated on ${populated}/${n}`;
    console.log(`    ${field.padEnd(24)} key on ${String(present).padStart(3)}/${n}, value on ${String(populated).padStart(3)}/${n}   ${verdict}`);
  };

  console.log('\n  -- BILLING FIELDS (the ingest depends on these) --');
  for (const f of BILLING_FIELDS) tally(f);
  console.log('\n  -- IDENTITY / SCHEDULING FIELDS --');
  for (const f of IDENTITY_FIELDS) tally(f);

  // ⚠ episodes[] is PHI. COUNTS ONLY — no episode_id, and `note` is never read.
  console.log('\n  -- episodes[] (attendance) — COUNTS ONLY, no identifiers printed --');
  const withEpisodes = rows.filter((r) => Array.isArray(r['episodes']));
  const totalEpisodes = withEpisodes.reduce((a, r) => a + (r['episodes'] as unknown[]).length, 0);
  const presentTrue = withEpisodes.reduce(
    (a, r) => a + (r['episodes'] as Record<string, unknown>[]).filter((e) => e['present'] === true).length,
    0,
  );
  const episodeKeys = new Set<string>();
  for (const r of withEpisodes) {
    for (const e of r['episodes'] as Record<string, unknown>[]) for (const k of Object.keys(e)) episodeKeys.add(k);
  }
  console.log(`    sessions carrying an episodes[] array : ${withEpisodes.length}/${n}`);
  console.log(`    total episode entries                 : ${totalEpisodes}`);
  console.log(`    entries with present === true         : ${presentTrue}`);
  console.log(`    per-entry keys returned               : ${[...episodeKeys].sort().join(', ') || '(none)'}`);
  console.log(`    ▶ present === true is the attendance flag the grid's "counted" filter needs.`);

  // ⚠ POPULATED IS NOT THE SAME AS DISCRIMINATING. `billable` counting as "populated on
  // every row" says only that it is non-null; if it is `true` on all of them it cannot
  // separate a billable session from a non-billable one, and the ingest would be filtering
  // on a constant. The DISTRIBUTION is the answer, so it is printed rather than inferred.
  console.log('\n  -- VALUE DISTRIBUTION for the low-cardinality discriminators --');
  for (const f of ['billable', 'status', 'session_type'] as const) {
    const counts = new Map<string, number>();
    for (const r of rows) {
      const k = describe(r[f as string]);
      counts.set(k, (counts.get(k) ?? 0) + 1);
    }
    const spread = [...counts.entries()].map(([k, v]) => `${k}×${v}`).join('  ');
    const verdict = counts.size <= 1 ? '  ⚠ CONSTANT — cannot discriminate' : '';
    console.log(`    ${f.padEnd(24)} ${spread}${verdict}`);
  }

  // One worked row, billing/config fields only. No episodes, no note, no identifiers.
  const sample = rows[0]!;
  console.log('\n  -- ONE SESSION, config fields only (no episode data) --');
  for (const f of [...IDENTITY_FIELDS, ...BILLING_FIELDS]) {
    console.log(`    ${f.padEnd(24)} ${describe(sample[f])}`);
  }
}

async function main(): Promise<void> {
  const c = creds();
  const location = argValue('location') ?? DEFAULT_LOCATION;
  const weekStart = argValue('week') ?? lastCompleteMonday(new Date());
  const weekEnd = addDays(weekStart, 6);
  const fourWeekStart = addDays(weekStart, -21);
  // --weeks=N widens STEP 1 itself. It exists because "constant in one week" and "constant
  // always" are different claims: `billable` came back true on all 16 sessions of a single
  // week, which cannot tell a genuinely-invariant field from a small sample. A wider first
  // window buys that answer for the SAME one call, rather than a second authentication.
  const weeks = Math.max(1, Number(argValue('weeks') ?? '1') || 1);
  const step1Start = addDays(weekStart, -7 * (weeks - 1));

  console.log('=== Kipu /api/group_sessions probe ===');
  console.log(`mode        : ${LIVE ? 'LIVE (up to 3 GETs, no retries)' : 'DRY RUN (no network)'}`);
  console.log(`access_id   : ${fingerprint(c.accessId)}`);
  console.log(`secret_key  : [set, ${c.secretKey.length} chars, not fingerprinted]`);
  console.log(`app_id      : ${fingerprint(c.appId)}`);
  console.log(`route       : GET /api/group_sessions   (Accept version=4)`);
  console.log(`location_id : ${location}`);
  console.log(`week        : ${step1Start} .. ${weekEnd}   (${weeks} week(s); widens to ${fourWeekStart} .. ${weekEnd} if empty)`);
  console.log('⚠ PHI: episodes[] is COUNTED, never printed. Non-200 bodies are withheld.');

  if (!LIVE) {
    console.log('\nDry run only. Re-run with --live to make the calls.');
    return;
  }

  const results: WindowResult[] = [];
  const step1 = await probeWindow(
    c,
    `STEP 1 — ${weeks} full Mon-Sun week(s), one location`,
    step1Start,
    weekEnd,
    location,
  );
  results.push(step1);

  // Escalate ONLY on an empty 200. A non-200 is already the answer; widening the window
  // would spend another authentication to re-learn it.
  if (step1.status === 200 && step1.sessionCount === 0) {
    const step2 = await probeWindow(c, 'STEP 2 — widened to four weeks, same location', fourWeekStart, weekEnd, location);
    results.push(step2);
    if (step2.status === 200 && step2.sessionCount === 0) {
      const step3 = await probeWindow(c, 'STEP 3 — four weeks, NO location filter (global control)', fourWeekStart, weekEnd, null);
      results.push(step3);
    }
  }

  console.log('\n═══════════════════ VERDICT ═══════════════════');
  for (const r of results) {
    console.log(`  ${r.label}`);
    console.log(`      HTTP ${r.transportError ? 'n/a' : r.status}, sessions=${r.sessionCount ?? 'n/a'}`);
  }
  const last = results[results.length - 1]!;
  if (last.status === 410) {
    console.log('\n  410 — THE ENDPOINT IS DISABLED FOR THIS INSTANCE. The planned ingest cannot');
    console.log('  be built this way. Escalate to Kipu to have it enabled before any more design.');
  } else if (last.status === 200 && (last.sessionCount ?? 0) > 0) {
    console.log('\n  200 WITH SESSIONS. Read the FIELD PRESENCE block above, not this line: a 200');
    console.log('  is not the answer. Any billing field marked "PRESENT BUT EMPTY ON EVERY ROW"');
    console.log('  is the same hole /api/care_levels has, and it changes the ingest design.');
  } else if (last.status === 200) {
    console.log('\n  200 BUT ZERO SESSIONS EVERYWHERE, including the unfiltered control. The route');
    console.log('  ANSWERS (not 410, not 403), so it is enabled — but this credential sees no');
    console.log('  group sessions. That is a SCOPE question, not a shape one, and the field');
    console.log('  contract is still UNTESTED. Do not record it as verified.');
  } else {
    console.log('\n  NON-200. Read explainStatus above; a 403 here is an identity verdict and is');
    console.log('  never transient — do not retry. Run the sibling probe --diagnose instead.');
  }
}

main().catch((err) => {
  // Never print the error object raw — a stack could carry a signed URL containing app_id.
  console.error(`probe failed: ${err instanceof Error ? err.message : 'error'}`);
  process.exit(1);
});
