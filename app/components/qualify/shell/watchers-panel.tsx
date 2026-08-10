'use client';

/**
 * WATCHERS — the board's persistence panel (mock: `.watchgrid`): trendwatchers (payers/prefixes
 * with a sparkline + threshold alert) and patient watchers (blind-token + masked echo). The
 * compliance footer is the mock's own line, kept verbatim — it is the contract 0096 implements.
 *
 * SESSION-ONLY MODE: `available:false` means mig 0096 is unapplied. Adds still work — they live in
 * the owner's React state and arrive here through the same props — but the panel says so, per item
 * and once at the top, because a rep who saves a watcher deserves to know whether it survives a
 * refresh. The moment 0096 applies the same props carry durable rows and the badges disappear.
 *
 * ERA-join alerts ("new ERA posted", the mock's pill) are a SEPARATE scoped session — see the 0096
 * header. The pill here says only what is true today: that the watcher exists.
 */
import type { QualifyPatientWatcher, QualifyTrendWatcher } from '../../../lib/qualify/watchers';
import { QUALIFY_PALETTE, RATING_HEX } from '../tokens';
import { Spark } from '../spark';
import { ZoneRule } from './board-zone';

export function WatchersPanel({
  available,
  readFailed = false,
  trend,
  patient,
  onDelete,
  watchAction,
}: {
  available: boolean;
  /** The READ failed — a different claim from "0096 unapplied", and the panel must not offer the
   *  latter's reassuring explanation for the former's problem (0089's costume). */
  readFailed?: boolean;
  trend: (QualifyTrendWatcher & { sessionOnly?: boolean })[];
  patient: (QualifyPatientWatcher & { sessionOnly?: boolean })[];
  /** Null id = a session-only item (index-keyed removal is the owner's job via key). */
  onDelete: (kind: 'trend' | 'patient', id: string | null, index: number) => void;
  /** The contextual "+ watch this search" affordance — the owner decides when one exists. */
  watchAction?: React.ReactNode;
}) {
  return (
    <section aria-label="Watchers" data-testid="qualify-watchers">
      <ZoneRule label="Watchers" tag="SAVED FROM PAST SEARCHES · ALERTS ON MOVEMENT" action={watchAction} />
      {readFailed ? (
        <p className="mb-2 rounded-lg border border-status-danger/40 bg-coral50 px-3 py-1.5 font-mono text-[10px] text-status-danger">
          saved watchers could not be read just now — anything below is this session only, and a
          watcher you already saved may exist but be hidden. Retry, or tell an admin if it persists.
        </p>
      ) : !available && (trend.length > 0 || patient.length > 0) ? (
        <p className="mb-2 rounded-lg border border-dashed border-line bg-ground px-3 py-1.5 font-mono text-[10px] text-ink400">
          this session only — durable storage arrives when migration 0096 is applied
        </p>
      ) : null}
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
                      era-835 join that is its own scoped session (0096 header), so the pill states
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
