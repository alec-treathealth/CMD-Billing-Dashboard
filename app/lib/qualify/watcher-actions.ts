'use server';

/**
 * Qualify WATCHER Server Actions — the write/read edge for the smoke-shell board's watcher and
 * recent-search panels (mig 0097).
 *
 * ⚠ 'use server' RULES (test/useServerExports.test.ts enforces): ONLY async functions exported.
 * Types + DI core live in ./watchers (plain module); this file is the thin binder, exactly like
 * board-actions.ts.
 *
 * ── WHERE PHI ENTERS AND WHERE IT STOPS ─────────────────────────────────────────────────────────
 * `saveQualifyWatcher` and `recordQualifyRecentSearch` accept the RAW TYPED TERM in the POST body —
 * the same transport getQualifySnapshot already uses for every search. The term is used for exactly
 * two derivations and then discarded:
 *   · the keyed-HMAC blind index (memberIdBlindIndex / alphaPrefixBlindIndex — the same tokens the
 *     search itself mints), and
 *   · a bounded display echo (maskedPatientEcho: 'GGS •••• 8841'; recentSearchEcho: ≤3 chars).
 * The raw term is NEVER stored, NEVER logged, and never appears in an error message. The 0097
 * column constraints make over-persistence structurally impossible (echo ≤13 chars, prefix ≤3).
 *
 * ── AUDIT POSTURE, decided rather than defaulted ────────────────────────────────────────────────
 * These writes read NO PHI rows: the mint is an in-process HMAC of operator input, and the row
 * written contains only the token + bounded echo. The repo's audit contract covers row-returning
 * PHI access (actions.ts: "the row-returning PHI access; the core audits it") — the search that put
 * the term on the operator's screen was already audited by that path. So these are gate-only, the
 * same posture as the board/movers/KPI reads. If the audit contract is ever widened to cover
 * PHI-DERIVED WRITES, this is the file to wire it in.
 */
import { requireQualifyPrincipal } from './gate';
import {
  clearQualifyRecentSearchRows,
  deleteQualifyWatcherRow,
  loadQualifyRecentSearchRows,
  loadQualifyWatcherRows,
  loadQualifyWatcherSeries,
  recordQualifyRecentSearchRow,
  saveQualifyWatcherRow,
} from './loaders';
import { getQualifyWatchboardCore, type QualifyWatchboardResult } from './watchers';
import { prefixLabelsFor } from '../../../src/collections/prefixLabel';
import {
  alphaPrefixBlindIndex,
  memberIdBlindIndex,
  ALPHA_PREFIX_LEN,
} from '../../../src/collections/blindIndex';
import { maskedPatientEcho, recentSearchEcho } from '../../../src/collections/qualifyWatchers';

export type QualifyWatchboardActionResult = { ok: true; board: QualifyWatchboardResult } | { ok: false };

/** The board's whole persistence read: watchers (+sparklines) + recent searches, one call. */
export async function getQualifyWatchboard(): Promise<QualifyWatchboardActionResult> {
  try {
    const board = await getQualifyWatchboardCore({
      requirePrincipal: async () => {
        const p = await requireQualifyPrincipal();
        return p.ok ? { ok: true, userId: p.actor.userId } : { ok: false, error: p.error };
      },
      loadWatchers: loadQualifyWatcherRows,
      loadRecent: loadQualifyRecentSearchRows,
      loadSeries: loadQualifyWatcherSeries,
      resolvePrefixes: prefixLabelsFor,
    });
    return { ok: true, board };
  } catch (err) {
    console.error('qualify watchboard failed:', err instanceof Error ? err.message : String(err));
    return { ok: false };
  }
}

export type QualifyWatcherSaveResult =
  | { ok: true; persisted: boolean }
  | { ok: false; reason: 'denied' | 'invalid' | 'failed' };

/**
 * Save a TREND watcher — a payer to follow, optionally pinned to the prefix that surfaced it.
 * `term` is the typed identifier (or '' when the watch came from a payer control with no search);
 * only its blind index survives.
 */
export async function saveQualifyTrendWatcher(input: {
  payer: string;
  term: string;
  thresholdPts: number;
}): Promise<QualifyWatcherSaveResult> {
  try {
    const p = await requireQualifyPrincipal();
    if (!p.ok) return { ok: false, reason: 'denied' };
    const payer = input.payer.trim();
    const threshold = Math.trunc(input.thresholdPts);
    if (payer.length === 0 || payer.length > 120 || threshold < 1 || threshold > 100) {
      return { ok: false, reason: 'invalid' };
    }
    // Pin to the prefix only when the term yields one (≥ALPHA_PREFIX_LEN chars) — a payer-wide
    // watch is the honest fallback, not an error.
    let token: string | null = null;
    try {
      token = input.term.trim().length >= ALPHA_PREFIX_LEN ? alphaPrefixBlindIndex(input.term) : null;
    } catch {
      token = null; // an unmintable term (e.g. all punctuation) degrades to payer-wide
    }
    const res = await saveQualifyWatcherRow({
      userId: p.actor.userId,
      kind: 'trend',
      payer,
      token,
      echo: null, // trend echoes resolve at read time via prefixLabel.ts — never stored (0097 header)
      thresholdPts: threshold,
    });
    return { ok: true, persisted: res.persisted };
  } catch (err) {
    console.error('save trend watcher failed:', err instanceof Error ? err.message : String(err));
    return { ok: false, reason: 'failed' };
  }
}

/**
 * Save a PATIENT watcher — the blind-index token + the masked echo, never the raw ID. Refuses a
 * term too short to mask meaningfully (maskedPatientEcho's <5-char rule): persisting a nearly-whole
 * identifier as its own "mask" would be the exact leak the mask exists to prevent.
 */
export async function saveQualifyPatientWatcher(input: {
  term: string;
  planContext: string | null;
}): Promise<QualifyWatcherSaveResult> {
  try {
    const p = await requireQualifyPrincipal();
    if (!p.ok) return { ok: false, reason: 'denied' };
    const echo = maskedPatientEcho(input.term);
    let token: string | null = null;
    try {
      token = memberIdBlindIndex(input.term);
    } catch {
      token = null;
    }
    if (echo === null || token === null) return { ok: false, reason: 'invalid' };
    const plan = input.planContext?.trim().slice(0, 120) || null;
    const res = await saveQualifyWatcherRow({
      userId: p.actor.userId,
      kind: 'patient',
      payer: plan,
      token,
      echo,
      thresholdPts: null,
    });
    return { ok: true, persisted: res.persisted };
  } catch (err) {
    console.error('save patient watcher failed:', err instanceof Error ? err.message : String(err));
    return { ok: false, reason: 'failed' };
  }
}

export async function deleteQualifyWatcher(id: string): Promise<QualifyWatcherSaveResult> {
  try {
    const p = await requireQualifyPrincipal();
    if (!p.ok) return { ok: false, reason: 'denied' };
    if (!/^\d{1,18}$/.test(id)) return { ok: false, reason: 'invalid' };
    const res = await deleteQualifyWatcherRow(p.actor.userId, id);
    return { ok: true, persisted: res.persisted };
  } catch (err) {
    console.error('delete watcher failed:', err instanceof Error ? err.message : String(err));
    return { ok: false, reason: 'failed' };
  }
}

/**
 * Record one resolved search's NON-PHI FACETS (payer label · ≤3-char prefix echo · plan class).
 * Takes the term ONLY to derive the echo server-side (a member-ID search degrades to its alpha
 * prefix — the 0097 compliance contract); the term itself is discarded. Fire-and-forget from the
 * client: a failed record must never disturb the search that just succeeded.
 */
export async function recordQualifyRecentSearch(input: {
  term: string;
  payer: string | null;
  planClass: string | null;
}): Promise<{ ok: boolean; persisted: boolean }> {
  try {
    const p = await requireQualifyPrincipal();
    if (!p.ok) return { ok: false, persisted: false };
    const res = await recordQualifyRecentSearchRow({
      userId: p.actor.userId,
      payer: input.payer?.trim().slice(0, 120) || null,
      echo: recentSearchEcho(input.term),
      planClass: input.planClass?.trim().slice(0, 40) || null,
    });
    return { ok: true, persisted: res.persisted };
  } catch (err) {
    console.error('record recent search failed:', err instanceof Error ? err.message : String(err));
    return { ok: false, persisted: false };
  }
}

export async function clearQualifyRecentSearches(): Promise<{ ok: boolean }> {
  try {
    const p = await requireQualifyPrincipal();
    if (!p.ok) return { ok: false };
    await clearQualifyRecentSearchRows(p.actor.userId);
    return { ok: true };
  } catch (err) {
    console.error('clear recent searches failed:', err instanceof Error ? err.message : String(err));
    return { ok: false };
  }
}
