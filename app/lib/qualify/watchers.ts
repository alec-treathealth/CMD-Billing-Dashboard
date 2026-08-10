/**
 * Qualify WATCHERS — the pure contract + DI core behind the smoke-shell board's watcher and
 * recent-search panels (mock: docs/mockups/qualify-smoke.html, the `watchgrid` + `recents` zones).
 * The board.ts pattern exactly: this module is plain (no 'use server', no I/O), the loaders own
 * the SQL, watcher-actions.ts is the thin binder, and the hermetic suite tests the core directly.
 *
 * ── THE AVAILABILITY UNION, now that 0097 IS APPLIED LIVE (2026-08-10, ledger 20260810120258) ────
 * `available: false` means the RELATIONS ARE ABSENT — the panels then run SESSION-ONLY: adds work,
 * live in React state, badged "this session only", gone on refresh. The union was written for the
 * pre-apply world, where that was the normal steady state; it is NOT retired, but its meaning has
 * inverted. The relations exist, so `available:false` is a FAULT — they went missing — and the panel
 * copy is fault-framed accordingly (it no longer promises that storage "arrives" with a migration).
 * Keeping the fail-soft is still right: a missing table should degrade the board, not 500 the page.
 * `ok: false` at the action layer means the READ ITSELF failed — a different claim, rendered as
 * absence. And a THIRD state lives only in the client: not-loaded-yet, which must never be collapsed
 * onto either of these (see `components/qualify/shell/shell-session.ts`'s `deriveBoardStatus`).
 *
 * ── NON-DOLLAR BY CONSTRUCTION ──────────────────────────────────────────────────────────────────
 * Everything here is a label, an echo, a rating, a count or a date. The sparkline series builder
 * (src/collections/qualifyWatchers.ts) projects ratings only — never the dollar columns beside
 * them — so an admissions_seat session derives byte-identical panels.
 */
import {
  foldWatcherSeries,
  watcherSeriesKey,
  type QualifyRecentSearchRow,
  type QualifyWatcherRow,
  type QualifyWatcherSeries,
  type QualifyWatcherSeriesRow,
} from '../../../src/collections/qualifyWatchers';

export interface QualifyTrendWatcher {
  id: string;
  kind: 'trend';
  payer: string;
  /** Readable ≤3-char prefix when the watch is pinned to one prefix (resolved via prefixLabel.ts
   *  server-side, same as the tape) — null on a payer-wide watch. */
  prefix: string | null;
  thresholdPts: number;
  since: string;
  /** Sparkline ratings oldest→newest off the 0093 daily table; [] while 0093 has no rows. */
  points: number[];
  ratingNow: number | null;
  deltaPts: number | null;
  /** |deltaPts| ≥ thresholdPts — the card renders its alert treatment. */
  alerting: boolean;
}

export interface QualifyPatientWatcher {
  id: string;
  kind: 'patient';
  /** The masked echo, e.g. 'GGS •••• 8841' — the raw ID is never stored so this is all there is. */
  echo: string;
  /** Plan context captured at save time (payer label · plan class), display-only. */
  planContext: string | null;
  since: string;
}

export interface QualifyRecentSearch {
  id: string;
  payer: string | null;
  /** ≤3-char alpha prefix echo — the re-run subject. Null means the facets carry no runnable
   *  term (recorded before an echo existed); the card renders without a re-run affordance. */
  prefixEcho: string | null;
  planClass: string | null;
  searchedAt: string;
}

export interface QualifyWatchboardResult {
  /** False = the relations did not answer → session-only mode. 0097 is applied, so this is a fault,
   *  not a stage. See the header union — and note the client adds a fourth, not-loaded-yet state. */
  available: boolean;
  trend: QualifyTrendWatcher[];
  patient: QualifyPatientWatcher[];
  recent: QualifyRecentSearch[];
}

export const EMPTY_WATCHBOARD: QualifyWatchboardResult = {
  available: false,
  trend: [],
  patient: [],
  recent: [],
};

export interface QualifyWatchboardDeps {
  /** Fail-closed gate; the same requireQualifyPrincipal the board uses. */
  requirePrincipal: () => Promise<{ ok: true; userId: string } | { ok: false; error: string }>;
  /** null = relations absent — NOT an empty list, and NOT "not loaded yet" (that state exists only
   *  in the client, where the loaders' result has not arrived at all). */
  loadWatchers: (userId: string) => Promise<QualifyWatcherRow[] | null>;
  loadRecent: (userId: string) => Promise<QualifyRecentSearchRow[] | null>;
  /** Rating series for the trend watchers' subjects; [] when 0093 has nothing for them. OPTIONAL
   *  dep and fail-soft INSIDE the core: a thrown series read costs the cards their sparklines,
   *  never the panel its rows (the board.ts enrichment discipline). */
  loadSeries?: (subjects: readonly { token: string | null; payer: string }[]) => Promise<QualifyWatcherSeriesRow[]>;
  /** Token → readable prefix (prefixLabel.ts). Optional; absent = prefix renders null. */
  resolvePrefixes?: (tokens: readonly string[]) => Map<string, string>;
}

export const QUALIFY_WATCHER_DEFAULT_THRESHOLD = 3;

/** The read core: rows + series → the panel contract. Pure given its deps. */
export async function getQualifyWatchboardCore(deps: QualifyWatchboardDeps): Promise<QualifyWatchboardResult> {
  const gate = await deps.requirePrincipal();
  if (!gate.ok) throw new Error(gate.error);

  const [watcherRows, recentRows] = await Promise.all([
    deps.loadWatchers(gate.userId),
    deps.loadRecent(gate.userId),
  ]);
  // EITHER relation absent → the whole surface is session-only. Both tables ship in 0097, which is
  // applied, so a half-present pair is not a state this union needs to flatter with per-panel
  // granularity — it would mean something dropped one table and not the other.
  if (watcherRows === null || recentRows === null) return EMPTY_WATCHBOARD;

  const trendRows = watcherRows.filter((r) => r.kind === 'trend');
  const patientRows = watcherRows.filter((r) => r.kind === 'patient');

  // Series + prefix labels are ENRICHMENT: each fails soft to absence, never taking the rows down.
  let series = new Map<string, QualifyWatcherSeries>();
  if (deps.loadSeries && trendRows.length > 0) {
    try {
      const rows = await deps.loadSeries(
        trendRows.map((r) => ({ token: r.subject_token, payer: r.payer_label ?? '' })),
      );
      series = foldWatcherSeries(rows);
    } catch {
      series = new Map();
    }
  }
  let prefixes = new Map<string, string>();
  if (deps.resolvePrefixes) {
    try {
      prefixes = deps.resolvePrefixes(
        trendRows.flatMap((r) => (r.subject_token !== null ? [r.subject_token] : [])),
      );
    } catch {
      prefixes = new Map();
    }
  }

  const trend: QualifyTrendWatcher[] = trendRows.map((r) => {
    const s = series.get(watcherSeriesKey(r.subject_token, r.payer_label ?? ''));
    const thresholdPts = r.threshold_pts ?? QUALIFY_WATCHER_DEFAULT_THRESHOLD;
    const deltaPts = s?.deltaPts ?? null;
    return {
      id: String(r.id),
      kind: 'trend',
      payer: r.payer_label ?? '',
      prefix: r.subject_token !== null ? (prefixes.get(r.subject_token) ?? null) : null,
      thresholdPts,
      since: r.created_at,
      points: s?.points ?? [],
      ratingNow: s?.ratingNow ?? null,
      deltaPts,
      alerting: deltaPts !== null && Math.abs(deltaPts) >= thresholdPts,
    };
  });

  /**
   * ⚠ NO RATING SERIES ON A PATIENT WATCHER, and this is a DATA fact rather than a missing feature
   * (adversarial review, 2026-08-10). The first version carried a `hasRatedHistory` flag fed from
   * the series map, and it was structurally always false for two independent reasons: `loadSeries`
   * is called with trend subjects only, AND a patient watcher's token is
   * `memberIdBlindIndex(term)` — the HMAC of the WHOLE member id — while the 0093 daily table keys
   * on `member_id_prefix_bidx`, the HMAC of the 3-char prefix. Different HMAC inputs; the join can
   * never match, so passing patient subjects would not have fixed it either. A field that can only
   * ever read false is a claim the UI then renders as if it meant something, so it is gone.
   *
   * What a patient watcher is FOR is the ERA-join alert ("new ERA posted"), which needs its own
   * scoped session (0097 header) — until then the panel says only that it is watching.
   */
  const patient: QualifyPatientWatcher[] = patientRows.map((r) => ({
    id: String(r.id),
    kind: 'patient',
    echo: r.display_echo ?? '••••',
    planContext: r.payer_label,
    since: r.created_at,
  }));

  const recent: QualifyRecentSearch[] = recentRows.map((r) => ({
    id: String(r.id),
    payer: r.payer_label,
    prefixEcho: r.prefix_echo,
    planClass: r.plan_class,
    searchedAt: r.searched_at,
  }));

  return { available: true, trend, patient, recent };
}
