'use client';

/**
 * WATCHERS — the board's persistence panel (mock: `.watchgrid`): trendwatchers (payers/prefixes
 * with a sparkline + threshold alert) and patient watchers (blind-token + masked echo). The
 * compliance footer is the mock's own line, kept verbatim — it is the contract 0097 implements.
 *
 * SESSION-ONLY MODE: `status:'absent'` means the watcher relations did not answer. Adds still work —
 * they live in the owner's React state and arrive here through the same props — but the panel says
 * so, per item and once at the top, because a rep who saves a watcher deserves to know whether it
 * survives a refresh.
 *
 * ⚠ THAT IS NOW A FAULT, NOT A PROVISIONING STAGE. Migration 0097 has been APPLIED LIVE since
 * 2026-08-10 (ledger 20260810120258), so the relations exist and `absent` should never be reachable;
 * if it is, something dropped them. The copy says the actionable thing ("tell an admin") and names
 * no migration — an admissions rep can do nothing with "0097", and the previous wording was shown to
 * every operator on every page load because `status` used to be a boolean that collapsed
 * NOT-LOADED-YET onto absent (see `deriveBoardStatus`). The number stays where it helps: the comment
 * in `app/lib/qualify/loaders.ts` beside the code that produces the state.
 *
 * ERA-join alerts ("new ERA posted", the mock's pill) are a SEPARATE scoped session — see the 0097
 * migration header. The pill here says only what is true today: that the watcher exists.
 */
import type { QualifyPatientWatcher, QualifyTrendWatcher } from '../../../lib/qualify/watchers';
import { QUALIFY_PALETTE, RATING_HEX } from '../tokens';
import { Spark } from '../spark';
import { ZoneRule } from './board-zone';
import { watcherSaveNotice, type QualifyBoardStatus, type QualifyWatcherSaveFailure } from './shell-session';

export function WatchersPanel({
  status,
  saveFailed = null,
  trend,
  patient,
  onDelete,
  watchAction,
}: {
  /** loading · durable · absent · failed. FOUR states and never a boolean: `failed` (the READ
   *  failed) and `absent` (the relations are missing) are different claims, and `loading` is neither
   *  — the panel must not offer a storage explanation before it has one. See `deriveBoardStatus`. */
  status: QualifyBoardStatus;
  /** The last WATCHER SAVE was refused or failed — the read direction's twin for writes.
   *  Null once any later save or delete succeeds; the owner clears it, this panel only states it. */
  saveFailed?: QualifyWatcherSaveFailure | null;
  trend: (QualifyTrendWatcher & { sessionOnly?: boolean })[];
  patient: (QualifyPatientWatcher & { sessionOnly?: boolean })[];
  /** Null id = a session-only item (index-keyed removal is the owner's job via key). */
  onDelete: (kind: 'trend' | 'patient', id: string | null, index: number) => void;
  /** The contextual "+ watch this search" affordance — the owner decides when one exists. */
  watchAction?: React.ReactNode;
}) {
  return (
    <section aria-label="Watchers" data-testid="qualify-watchers">
      <ZoneRule label="Watchers" tag="SAVED FROM PAST SEARCHES · ALERTS ON MOVEMENT" action={watchAction} level={2} />
      {/* ── THE SAVE'S OWN CHANNEL ──────────────────────────────────────────────────────────────
          ALWAYS MOUNTED, EMPTY WHEN THERE IS NOTHING TO SAY. A live region that appears at the same
          moment its text does is unreliably announced — the region has to exist for the change to be
          a change. So the wrapper is unconditional (it renders nothing and occupies nothing) and only
          the sentence is conditional. `role="status"` + `aria-live="polite"` because this must never
          interrupt: the watcher failing is not a reason to talk over whatever the operator is
          reading, but it is emphatically a reason not to stay silent. */}
      <div role="status" aria-live="polite">
        {saveFailed ? (
          <p className="mb-2 rounded-lg border border-status-danger/40 bg-coral50 px-3 py-1.5 font-mono text-[10px] text-status-danger">
            {watcherSaveNotice(saveFailed)}
          </p>
        ) : null}
      </div>
      {status === 'failed' ? (
        <p className="mb-2 rounded-lg border border-status-danger/40 bg-coral50 px-3 py-1.5 font-mono text-[10px] text-status-danger">
          saved watchers could not be read just now — anything below is this session only, and a
          watcher you already saved may exist but be hidden. Retry, or tell an admin if it persists.
        </p>
      ) : status === 'absent' && (trend.length > 0 || patient.length > 0) ? (
        <p className="mb-2 rounded-lg border border-status-danger/40 bg-coral50 px-3 py-1.5 font-mono text-[10px] text-status-danger">
          this session only — saved watchers are unavailable, so anything below disappears on
          refresh. Tell an admin if it persists.
        </p>
      ) : null}
      {/* `loading` renders NOTHING here on purpose — the pre-fetch window must make no claim about
          storage in either direction. It is also why this is a switch on four states rather than a
          `!available` test: the boolean made every page load open with the absent-state sentence. */}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <div>
          <h3 className="mb-1.5 flex items-baseline gap-2 font-head text-[12.5px] font-semibold text-ink900">
            Trendwatchers
            <span className="font-mono text-[9.5px] font-normal uppercase tracking-wide text-ink400">
              payers &amp; prefixes you follow
            </span>
          </h3>
          {trend.length === 0 ? (
            <p className="rounded-lg border border-dashed border-line px-3 py-3 text-[12px] text-ink400">
              Nothing watched yet — resolve a search, then “watch” its payer to track movement here.
            </p>
          ) : (
            <ul className="flex flex-col gap-1.5">
              {trend.map((w, i) => (
                <li
                  key={w.id || `session-${i}`}
                  className={[
                    'flex items-center gap-3 rounded-xl border px-3 py-2',
                    w.alerting ? 'border-coral400 bg-coral50' : 'border-line bg-surface',
                  ].join(' ')}
                >
                  <span className="w-10 shrink-0 font-mono text-[12px] font-bold text-teal700">{w.prefix ?? '—'}</span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[12.5px] font-semibold text-ink900">{w.payer}</span>
                    <span className="block font-mono text-[10px] text-ink400">
                      since {w.since} · alert ±{w.thresholdPts} pts
                      {w.sessionOnly ? ' · session only' : ''}
                      {w.alerting ? ' · MOVED PAST YOUR THRESHOLD' : ''}
                    </span>
                  </span>
                  {w.points.length >= 2 ? (
                    <Spark
                      points={w.points}
                      hex={(w.deltaPts ?? 0) < 0 ? RATING_HEX.danger : QUALIFY_PALETTE.teal500}
                      width={90}
                      height={26}
                    />
                  ) : (
                    <span className="font-mono text-[9.5px] text-ink400">no history yet</span>
                  )}
                  <span className="w-14 shrink-0 text-right">
                    <span className="block font-display text-lg leading-none text-ink900">{w.ratingNow ?? '—'}</span>
                    {w.deltaPts !== null ? (
                      <span
                        className="block font-mono text-[10px]"
                        style={{ color: w.deltaPts < 0 ? RATING_HEX.danger : RATING_HEX.ok }}
                      >
                        {w.deltaPts > 0 ? `▲ +${w.deltaPts}` : w.deltaPts < 0 ? `▼ ${w.deltaPts}` : '◆ 0'}
                      </span>
                    ) : null}
                  </span>
                  <button
                    type="button"
                    onClick={() => onDelete('trend', w.id || null, i)}
                    aria-label={`Stop watching ${w.payer}`}
                    className="rounded p-1 text-ink400 transition-colors hover:text-status-danger"
                  >
                    ✕
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>

        <div>
          <h3 className="mb-1.5 flex items-baseline gap-2 font-head text-[12.5px] font-semibold text-ink900">
            Patient watchers
            <span className="font-mono text-[9.5px] font-normal uppercase tracking-wide text-ink400">
              token-stored · never the raw ID
            </span>
          </h3>
          {patient.length === 0 ? (
            <p className="rounded-lg border border-dashed border-line px-3 py-3 text-[12px] text-ink400">
              None yet — after a full member-ID search, “watch this patient” stores the blind token
              and a masked echo, never the ID itself.
            </p>
          ) : (
            <ul className="flex flex-col gap-1.5">
              {patient.map((w, i) => (
                <li key={w.id || `session-${i}`} className="flex items-center gap-3 rounded-xl border border-line bg-surface px-3 py-2">
                  <span aria-hidden>🔒</span>
                  <span className="font-mono text-[12px] font-semibold text-ink900">{w.echo}</span>
                  <span className="min-w-0 flex-1 truncate text-[11.5px] text-ink600">{w.planContext ?? '—'}</span>
                  {/* The mock's pill said "new ERA posted" / "auth window closing". Those need the
                      era-835 join that is its own scoped session (0097 header), so the pill states
                      only what is true today rather than a status nothing computes. */}
                  <span className="rounded-full bg-ground px-2 py-0.5 font-mono text-[9.5px] text-ink400">
                    {w.sessionOnly ? 'session only' : 'watching'}
                  </span>
                  <button
                    type="button"
                    onClick={() => onDelete('patient', w.id || null, i)}
                    aria-label={`Stop watching ${w.echo}`}
                    className="rounded p-1 text-ink400 transition-colors hover:text-status-danger"
                  >
                    ✕
                  </button>
                </li>
              ))}
            </ul>
          )}
          <p className="mt-2 font-mono text-[9.5px] leading-relaxed text-ink400">
            watchers persist the keyed-HMAC token + a masked echo only — the raw member ID is never stored
          </p>
        </div>
      </div>
    </section>
  );
}
