/**
 * QUALIFY WATCHERS — query builders + pure folds for the smoke-shell board's persistence surfaces
 * (mig 0097: claims.qualify_watcher / claims.qualify_recent_search) and the sparkline series they
 * read off the ALREADY-LIVE 0093 daily rating table.
 *
 * Parameterized queries only; every table/column name is a fixed literal; only values are $n bound
 * params (standing rule). All builders return { sql, params } for the unnamed-statement pool
 * (Supavisor 6543 forbids named prepared statements).
 *
 * PHI POSTURE, per surface:
 *   · watcher rows      — token (keyed-HMAC blind index), masked echo (≤13 chars), payer label,
 *                         threshold. No raw identifier is selectable because none is stored.
 *   · recent searches   — payer label · ≤3-char prefix echo · plan class · timestamp. The facet
 *                         allowlist IS the compliance contract (0097 header).
 *   · sparkline series  — ratings + dates off qualify_policy_rating_daily. Non-dollar by
 *                         PROJECTION: that table carries billed/allowed/paid columns and this
 *                         builder must never select them — an admissions_seat session reads the
 *                         identical series.
 */

export const QUALIFY_WATCHER_SERIES_DAYS = 90;
/**
 * The per-user watcher cap `claims.save_qualify_watcher` (0097) enforces on NEW rows. The real limit
 * lives in that definer as a literal, not here — this constant exists so the two can be asserted
 * equal (`test/qualifyWatchers.test.ts`) instead of silently drifting apart, which is the failure
 * mode a source-of-truth constant with no consumer invites.
 */
export const QUALIFY_WATCHER_MAX = 40;
/**
 * Recent-search history depth `claims.record_qualify_recent_search` (0097) prunes past. Consumed
 * directly by `buildRecentSearchListQuery`'s LIMIT below, and asserted against the definer's own
 * literal in `test/qualifyWatchers.test.ts` so the two cannot silently diverge.
 */
export const QUALIFY_RECENT_MAX = 20;

export interface QualifyWatcherRow {
  id: string | number; // bigint: node-pg returns int8 as a STRING (pg-bigint-reads-as-string)
  kind: 'trend' | 'patient';
  payer_label: string | null;
  subject_token: string | null;
  display_echo: string | null;
  threshold_pts: number | null;
  created_at: string;
}

export interface QualifyRecentSearchRow {
  id: string | number;
  payer_label: string | null;
  prefix_echo: string | null;
  plan_class: string | null;
  searched_at: string;
}

export interface QualifyWatcherSeriesRow {
  member_id_prefix_bidx: string | null;
  primary_payer: string;
  as_of_date: string;
  rating: number | null;
}

/** A user's watchers, newest first. App-layer user scoping (0046 model: the WHERE is the scope,
 *  and the Server Action passes its own authenticated uid — never client input). */
export function buildWatcherListQuery(userId: string): { sql: string; params: unknown[] } {
  return {
    sql:
      'select id, kind, payer_label, subject_token, display_echo, threshold_pts, ' +
      "to_char(created_at, 'YYYY-MM-DD') as created_at " +
      'from claims.qualify_watcher where app_user_id = $1::uuid order by created_at desc, id desc',
    params: [userId],
  };
}

export function buildRecentSearchListQuery(userId: string): { sql: string; params: unknown[] } {
  return {
    sql:
      'select id, payer_label, prefix_echo, plan_class, ' +
      "to_char(searched_at at time zone 'utc', 'YYYY-MM-DD\"T\"HH24:MI:SS\"Z\"') as searched_at " +
      'from claims.qualify_recent_search where app_user_id = $1::uuid ' +
      // QUALIFY_RECENT_MAX rides as $2, not interpolated — a LIMIT is a value, and the standing
      // rule (CLAUDE.md) is only table/column/GUC names are fixed literals; every value is a
      // bound param. The 0097 definer already prunes to this many rows; this LIMIT is a
      // display-side belt-and-braces bound, not the source of truth.
      'order by searched_at desc, id desc limit $2::int',
    params: [userId, QUALIFY_RECENT_MAX],
  };
}

/**
 * Rating series for the trend watchers' sparklines, off the 0093 daily table.
 *
 * TWO SUBJECT SHAPES IN ONE QUERY, matching the two trend-watcher shapes 0097 stores:
 *   · token-pinned  (subject_token + payer_label) — the pair's own daily rating, verbatim.
 *   · payer-wide    (payer_label only)            — the LINE-WEIGHTED mean across that payer's
 *     rated pairs per day. Weighted, not flat-averaged: a 3-member pair and a 300-line book pair
 *     are not the same evidence, and a flat mean would let the thinnest pairs steer the line.
 *
 * Selected by `(token is null and $n is null) or token = $n` per subject, unioned by the caller —
 * here we take arrays and use unnest so ONE round trip serves every watcher on the board.
 * Ratings only — never the dollar columns beside them (header contract).
 */
export function buildWatcherSeriesQuery(
  subjects: readonly { token: string | null; payer: string }[],
): { sql: string; params: unknown[] } {
  const tokens = subjects.map((s) => s.token);
  const payers = subjects.map((s) => s.payer);
  return {
    sql:
      'with subjects as ( ' +
      '  select s.token, s.payer from unnest($1::text[], $2::text[]) as s(token, payer) ' +
      '), pinned as ( ' +
      '  select d.member_id_prefix_bidx, d.primary_payer, ' +
      "         to_char(d.as_of_date, 'YYYY-MM-DD') as as_of_date, d.rating::int as rating " +
      '  from collections.qualify_policy_rating_daily d ' +
      '  join subjects s on s.token is not null ' +
      '    and d.member_id_prefix_bidx = s.token and d.primary_payer = s.payer ' +
      '  where d.as_of_date >= current_date - $3::int ' +
      '), payerwide as ( ' +
      '  select null::text as member_id_prefix_bidx, d.primary_payer, ' +
      "         to_char(d.as_of_date, 'YYYY-MM-DD') as as_of_date, " +
      '         (sum(d.rating * d.line_count)::numeric / nullif(sum(d.line_count), 0))::int as rating ' +
      '  from collections.qualify_policy_rating_daily d ' +
      '  join subjects s on s.token is null and d.primary_payer = s.payer ' +
      '  where d.as_of_date >= current_date - $3::int and d.rating is not null ' +
      '  group by d.primary_payer, d.as_of_date ' +
      ') ' +
      'select member_id_prefix_bidx, primary_payer, as_of_date, rating from pinned ' +
      'union all ' +
      'select member_id_prefix_bidx, primary_payer, as_of_date, rating from payerwide ' +
      'order by as_of_date asc',
    params: [tokens, payers, QUALIFY_WATCHER_SERIES_DAYS],
  };
}

/** The composite-key separator, written as an ESCAPE so this file stays text. */
const KEY_SEP = '\u0000';

// ── Pure folds (hermetically tested; no I/O) ─────────────────────────────────────────────────────

export interface QualifyWatcherSeries {
  /** Ratings oldest→newest, nulls dropped (Spark needs ≥2 points to draw). */
  points: number[];
  ratingNow: number | null;
  /** Movement over the series window: newest − oldest, null under 2 points. */
  deltaPts: number | null;
}

/** Fold the one-round-trip series rows into per-subject series. Key = token + KEY_SEP + payer.
 *
 *  ⚠ THE SEPARATOR IS AN ESCAPE (`\u0000`), NEVER A LITERAL NUL IN THE SOURCE. An earlier draft
 *  pasted the raw byte in, which makes git and grep classify this whole file as BINARY — no diff, no
 *  review, no grep hit, and a PHI-adjacent module is the worst possible one to make unreviewable.
 *  Same separator SEMANTICS facilityKey uses (it cannot occur in a hex token or a payer label); only
 *  the spelling differs, and the spelling is the entire point. */
export function foldWatcherSeries(rows: readonly QualifyWatcherSeriesRow[]): Map<string, QualifyWatcherSeries> {
  const grouped = new Map<string, number[]>();
  for (const row of rows) {
    if (row.rating === null) continue;
    const key = `${row.member_id_prefix_bidx ?? ''}${KEY_SEP}${row.primary_payer}`;
    const arr = grouped.get(key);
    if (arr) arr.push(row.rating);
    else grouped.set(key, [row.rating]);
  }
  const out = new Map<string, QualifyWatcherSeries>();
  for (const [key, points] of grouped) {
    const first = points[0];
    const last = points[points.length - 1];
    out.set(key, {
      points,
      ratingNow: last ?? null,
      deltaPts: points.length >= 2 && first !== undefined && last !== undefined ? last - first : null,
    });
  }
  return out;
}

export function watcherSeriesKey(token: string | null, payer: string): string {
  return `${token ?? ''}${KEY_SEP}${payer}`;
}

/** Characters the echo must leave hidden. Below this the term is not maskable and is REFUSED. */
export const MASKED_ECHO_MIN_HIDDEN = 3;
const ECHO_PREFIX_LEN = 3;
const ECHO_TAIL_LEN = 4;

/**
 * The masked display echo a PATIENT watcher stores: `ABC •••• 1234` — the ≤3-char alpha prefix the
 * UI already renders openly, a mask, and the LAST FOUR of the member id. Derived server-side at save
 * time from the raw term, which is then discarded; this is the ONLY implementation of the format, so
 * the mock's compliance footer ("token + masked echo only") has exactly one place to audit.
 *
 * ⚠ THE LENGTH RULE IS THE WHOLE SAFETY PROPERTY, and the first version got it wrong in a way that
 * inverted the feature (found in adversarial review, 2026-08-10). It refused only terms under FIVE
 * characters — but prefix(0..3) and tail(-4) OVERLAP below eight, so a 7-character id like
 * `ABC1234` produced `ABC •••• 1234`: every character, in order, nothing masked, 13 chars wide so
 * it satisfied every column CHECK. The "mask" persisted the identifier verbatim.
 *
 * The rule now counts HIDDEN characters instead of total length, which is the property actually
 * being claimed, and it degrades before it refuses:
 *   · ≥ 10 chars → `PRE •••• 1234` (3 revealed + 4 revealed, ≥3 hidden)
 *   · 8-9 chars  → `••• •••• 1234` (tail only, ≥4 hidden) — the plan prefix is dropped rather than
 *                  the whole watcher, because a rep with a short id still deserves the feature
 *   · < 8 chars  → null. Not maskable at this width; the save action refuses and the rep can use a
 *                  trend watcher instead. Refusing is the correct failure — the alternative is
 *                  storing an identifier and calling it a mask.
 */
export function maskedPatientEcho(rawTerm: string): string | null {
  const norm = rawTerm.toUpperCase().replace(/[^A-Z0-9]/g, '');
  // Tail-only form still needs MASKED_ECHO_MIN_HIDDEN hidden, so the floor is 4 + 3 = 7... but the
  // prefix form needs 3 + 3 + 4 = 10. Both are derived here rather than hardcoded so a change to
  // either constant moves the guard with it.
  const tailOnlyFloor = ECHO_TAIL_LEN + MASKED_ECHO_MIN_HIDDEN + 1; // 8 — one extra, deliberately
  const prefixFloor = ECHO_PREFIX_LEN + MASKED_ECHO_MIN_HIDDEN + ECHO_TAIL_LEN; // 10
  if (norm.length < tailOnlyFloor) return null;
  const tail = norm.slice(-ECHO_TAIL_LEN);
  if (norm.length < prefixFloor) return `••• •••• ${tail}`;
  const prefix = norm.slice(0, ECHO_PREFIX_LEN).replace(/[^A-Z]/g, '');
  return `${prefix.length > 0 ? prefix : '•••'} •••• ${tail}`;
}

/** The ≤3-char alpha prefix echo a RECENT SEARCH may persist — [A-Z0-9]{1,3} or null, exactly the
 *  0097 CHECK constraint, so a violation is caught here as a null rather than surfacing as a 500. */
export function recentSearchEcho(rawTerm: string): string | null {
  const norm = rawTerm.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 3);
  return /^[A-Z0-9]{1,3}$/.test(norm) ? norm : null;
}
