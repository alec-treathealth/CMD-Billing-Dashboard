'use client';

/**
 * Qualify tab — the interactive container. Owns search/window/toggle/modal state and is the only
 * caller of the getQualifySnapshot Server Action (the browser's sole data path). It hands plain,
 * already-shaped data to the pure presentational children (facility panel, cases table, VOB modal).
 *
 * Amounts capability is server-authoritative: it comes from the snapshot once one exists, and is
 * seeded before the first search by the server-derived prop so an admissions_seat never renders the
 * $ column headers even on the empty state.
 *
 * Window control is 7/14/30/60/90 (contract QUALIFY_WINDOW_OPTIONS) — the mock's "Month" was
 * dropped (Alec) because it is a different window shape than the contract's trailing-N-days math.
 */
import { useCallback, useMemo, useState, useTransition } from 'react';
import { Search } from 'lucide-react';
import { getQualifySnapshot, revealQualifyRow } from '@/lib/qualify/actions';
import {
  QUALIFY_WINDOW_OPTIONS,
  type QualifySnapshot,
  type QualifyWindowDays,
  type QualifyPhi,
} from '@/lib/qualify/contract';
import { buildFacilityBucketMap } from '@/components/qualify/colors';
import { FacilityPanel } from '@/components/qualify/facility-panel';
import { CasesTable } from '@/components/qualify/cases-table';
import { VobModal } from '@/components/qualify/vob-modal';

const MIN_QUERY_LEN = 3;

/** windowStart (inclusive) .. windowEnd (EXCLUSIVE) → "Jun 18 – Jul 17, 2026" (inclusive last day). */
function formatWindowRange(startIso: string, endExclusiveIso: string): string {
  const start = new Date(`${startIso}T00:00:00Z`);
  const endIncl = new Date(new Date(`${endExclusiveIso}T00:00:00Z`).getTime() - 86_400_000);
  const mo = (d: Date) => d.toLocaleString('en-US', { month: 'short', timeZone: 'UTC' });
  return `${mo(start)} ${start.getUTCDate()} – ${mo(endIncl)} ${endIncl.getUTCDate()}, ${endIncl.getUTCFullYear()}`;
}

export function QualifyTab({
  viewerHasAmountsCapability,
  canRevealPhi,
}: {
  viewerHasAmountsCapability: boolean;
  canRevealPhi: boolean;
}) {
  const [query, setQuery] = useState('');
  const [windowDays, setWindowDays] = useState<QualifyWindowDays>(30);
  const [snapshot, setSnapshot] = useState<QualifySnapshot | null>(null);
  const [isPending, startTransition] = useTransition();
  const [heatOn, setHeatOn] = useState(true);
  const [modalOpen, setModalOpen] = useState(false);
  const [echo, setEcho] = useState('');
  const [hint, setHint] = useState<string | null>(null);
  const [hasSearched, setHasSearched] = useState(false);
  // PHI reveal (Prompt 3c): `revealed` caches the FETCHED PHI for the session (never dropped on hide);
  // `shown` controls visibility. Toggling a revealed row off/on never re-audits — one audited
  // revealQualifyRow per row per session. All four reset on a new search.
  const [revealed, setRevealed] = useState<Map<number, QualifyPhi>>(() => new Map());
  const [shown, setShown] = useState<Set<number>>(() => new Set());
  const [pendingIds, setPendingIds] = useState<Set<number>>(() => new Set());
  const [revealErrors, setRevealErrors] = useState<Map<number, string>>(() => new Map());

  const hasAmounts = snapshot ? snapshot.viewerHasAmountsCapability : viewerHasAmountsCapability;
  const facilityBuckets = useMemo(
    () => buildFacilityBucketMap(snapshot?.facilities ?? []),
    [snapshot],
  );

  const runSearch = useCallback((rawQuery: string, w: QualifyWindowDays) => {
    const trimmed = rawQuery.trim();
    if (trimmed.length < MIN_QUERY_LEN) {
      setHint(`Enter at least a ${MIN_QUERY_LEN}-letter alpha prefix or a full member ID.`);
      return;
    }
    setHint(null);
    // New search → discard any revealed PHI from the previous payer.
    setRevealed(new Map());
    setShown(new Set());
    setPendingIds(new Set());
    setRevealErrors(new Map());
    startTransition(async () => {
      try {
        const snap = await getQualifySnapshot({ query: trimmed, windowDays: w });
        setSnapshot(snap);
        setHasSearched(true);
        if (snap.resolved === null) {
          setEcho(trimmed);
          setModalOpen(true);
        } else {
          setModalOpen(false);
        }
      } catch {
        // The action fails closed (throws) when there is no per-user principal to audit against
        // (e.g. the no-auth staged-rollout fallback) or on a transient error — surface a friendly
        // hint rather than an uncaught rejection. Never echoes the underlying error (could name a
        // field/config).
        setHint('Qualify is unavailable right now. Please try again.');
      }
    });
  }, []);

  const toggleReveal = useCallback(
    (id: number) => {
      // Hide (visibility only — keep the fetched PHI cached).
      if (shown.has(id)) {
        setShown((s) => {
          const n = new Set(s);
          n.delete(id);
          return n;
        });
        return;
      }
      // Already fetched this session → just show it again. No re-fetch, no re-audit.
      if (revealed.has(id)) {
        setShown((s) => new Set(s).add(id));
        return;
      }
      if (pendingIds.has(id)) return; // in flight
      // First reveal for this row → the ONE audited fetch.
      setPendingIds((p) => new Set(p).add(id));
      setRevealErrors((e) => {
        const n = new Map(e);
        n.delete(id);
        return n;
      });
      void (async () => {
        try {
          const res = await revealQualifyRow(id);
          setPendingIds((p) => {
            const n = new Set(p);
            n.delete(id);
            return n;
          });
          if (res.ok) {
            setRevealed((m) => new Map(m).set(id, res.phi));
            setShown((s) => new Set(s).add(id));
          } else {
            setRevealErrors((e) => new Map(e).set(id, res.error));
          }
        } catch {
          setPendingIds((p) => {
            const n = new Set(p);
            n.delete(id);
            return n;
          });
          setRevealErrors((e) => new Map(e).set(id, 'Reveal is unavailable right now.'));
        }
      })();
    },
    [shown, revealed, pendingIds],
  );

  const onWindow = (w: QualifyWindowDays) => {
    setWindowDays(w);
    // Re-run only when a payer is already resolved, so the panels track the new window.
    if (snapshot?.resolved) runSearch(query, w);
  };

  const resolved = snapshot?.resolved ?? null;

  return (
    <main className="mx-auto max-w-[1280px] space-y-4 p-6 sm:p-8">
      {/* page head + color-layer toggle */}
      <div className="flex items-end justify-between gap-5">
        <div>
          <h1 className="font-display text-2xl font-semibold tracking-tight">Qualify</h1>
          <p className="mt-0.5 text-sm text-muted-foreground">
            Admissions lead qualification · resolve a payer, read facility performance and recent cases
          </p>
        </div>
        <button
          type="button"
          role="switch"
          aria-checked={heatOn}
          onClick={() => setHeatOn((v) => !v)}
          className="inline-flex items-center gap-2 text-xs font-semibold text-muted-foreground"
        >
          <span>Color layer</span>
          <span className={['relative h-[22px] w-[38px] rounded-full transition-colors', heatOn ? 'bg-teal700' : 'bg-line'].join(' ')}>
            <span
              className={['absolute top-0.5 h-[18px] w-[18px] rounded-full bg-white shadow-ths transition-all', heatOn ? 'left-[18px]' : 'left-0.5'].join(' ')}
            />
          </span>
        </button>
      </div>

      {/* filter / search bar */}
      <div className="flex flex-wrap items-center gap-3.5 rounded-xl border border-t-2 border-t-teal700 bg-card p-3.5 shadow-sm">
        <div className="relative min-w-[280px] max-w-[460px] flex-1">
          <Search aria-hidden className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-ink400" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') runSearch(query, windowDays);
            }}
            spellCheck={false}
            placeholder="3-letter alpha prefix or member ID"
            aria-label="Member ID or alpha prefix"
            className="h-10 w-full rounded-xl border bg-background pl-9 pr-3 text-sm text-ink900 outline-none focus:border-teal500 focus:bg-white focus:ring-4 focus:ring-teal50"
          />
        </div>
        <button
          type="button"
          onClick={() => runSearch(query, windowDays)}
          disabled={isPending}
          className="rounded-xl border border-teal200 bg-teal50 px-4 py-2 text-[13px] font-semibold text-teal700 transition-colors hover:bg-teal200 disabled:opacity-60"
        >
          {isPending ? 'Resolving…' : 'Resolve payer'}
        </button>
        <div className="h-6 w-px bg-line" />
        <div className="inline-flex rounded-full border bg-background p-0.5" role="group" aria-label="Time window">
          {QUALIFY_WINDOW_OPTIONS.map((w) => (
            <button
              key={w}
              type="button"
              onClick={() => onWindow(w)}
              aria-pressed={windowDays === w}
              className={['rounded-full px-3 py-1.5 text-xs font-semibold transition-colors', windowDays === w ? 'bg-teal700 text-white' : 'text-muted-foreground hover:text-ink900'].join(' ')}
            >
              {w}d
            </button>
          ))}
        </div>
      </div>
      {hint ? <p className="px-1 text-xs text-status-warn">{hint}</p> : null}

      {/* resolved context */}
      {resolved ? (
        <div className="flex flex-wrap items-center gap-3 px-0.5">
          <span className="inline-flex items-center gap-2 rounded-full bg-teal900 py-1.5 pl-3 pr-3.5 text-[13.5px] font-semibold text-white">
            <span className="text-[10px] font-bold uppercase tracking-wider text-teal200">Resolved payer</span>
            {resolved.payerName}
          </span>
          <span className="text-[13px] text-muted-foreground">
            {resolved.matchedOn === 'prefix' ? (
              <>
                matched on prefix <span className="font-mono text-ink900">{resolved.matchedValue}</span>
              </>
            ) : (
              <>matched on member ID</>
            )}{' '}
            · <span className="font-mono text-ink900">{resolved.totalCharges.toLocaleString('en-US')}</span> charges across{' '}
            <span className="font-mono text-ink900">{resolved.facilityCount}</span> facilities · window{' '}
            <span className="font-mono text-ink900">{formatWindowRange(resolved.windowStart, resolved.windowEnd)}</span>
          </span>
        </div>
      ) : null}

      {/* grid or empty prompt */}
      {snapshot && snapshot.resolved ? (
        <div className="grid grid-cols-1 items-start gap-4 min-[960px]:grid-cols-[340px_1fr]">
          <FacilityPanel facilities={snapshot.facilities} hasAmounts={hasAmounts} heatOn={heatOn} />
          <CasesTable
            cases={snapshot.cases}
            hasAmounts={hasAmounts}
            heatOn={heatOn}
            facilityBuckets={facilityBuckets}
            canReveal={canRevealPhi}
            revealed={revealed}
            shown={shown}
            pendingIds={pendingIds}
            revealErrors={revealErrors}
            onToggle={toggleReveal}
          />
        </div>
      ) : (
        <div className="rounded-xl border border-dashed bg-card p-10 text-center text-sm text-muted-foreground">
          {hasSearched
            ? 'No payer resolved for that identifier in the selected window.'
            : 'Search a member ID or 3-letter alpha prefix to resolve a payer and see facility performance and recent cases.'}
        </div>
      )}

      <VobModal open={modalOpen} query={echo} onClose={() => setModalOpen(false)} />
    </main>
  );
}
