/**
 * The scope notice — renders `deriveScopeNotice`'s verdict between the readout and the ranking.
 * Presentational only (the decision is pure, in app/lib/qualify/scopeNotice.ts) and non-dollar, so
 * it is identical for an admissions_seat session.
 *
 * Placement is the point: it sits directly ABOVE the ranking it is about, because a caveat printed
 * below a 27-card list is a caveat nobody reads.
 */
import type { QualifyScopeNotice } from '../../lib/qualify/scopeNotice';

export function ScopeNotice({ notice }: { notice: QualifyScopeNotice | null }) {
  if (!notice) return null;
  const warn = notice.tone === 'warn';
  return (
    <div
      role={warn ? 'alert' : 'note'}
      data-testid="qualify-scope-notice"
      data-tone={notice.tone}
      className={[
        'flex items-start gap-3 rounded-2xl border px-4 py-3',
        warn ? 'border-coral400 bg-coral50' : 'border-line bg-ground',
      ].join(' ')}
    >
      <span
        aria-hidden
        className={[
          'mt-px flex h-5 w-5 shrink-0 items-center justify-center rounded-md text-[12px] font-bold',
          warn ? 'bg-status-danger text-white' : 'bg-teal700 text-white',
        ].join(' ')}
      >
        {warn ? '!' : 'i'}
      </span>
      <span className="min-w-0">
        <b className={['block text-[13px] font-semibold leading-snug', warn ? 'text-status-danger' : 'text-ink900'].join(' ')}>
          {notice.headline}
        </b>
        <span className="mt-0.5 block text-[12px] leading-relaxed text-ink600">{notice.detail}</span>
      </span>
    </div>
  );
}
