'use client';

/**
 * Qualify Phase 3 — the patient-group "View cohort" right slide-over: the member's LIFETIME
 * alpha-prefix cohort context (payer-behavior peer group) — patients count, end-to-end yield pcts,
 * payer mix, CPT mix. Suppression-first: `data.suppressed` renders the honest "not enough data"
 * state (the SAME COHORT_MIN_PATIENTS floor the collections cohort curve enforces) — never a thin
 * identifiable slice. Dollar `charge` values arrive ALREADY stripped (null) for non-amounts viewers
 * (core choke point); this component additionally omits the dollar column from the DOM when
 * !data.viewerHasAmountsCapability (belt-and-suspenders, the FacilityPanel pattern).
 *
 * Pure/presentational (props only, no hooks) → hermetic under renderToStaticMarkup. Relative
 * imports so it loads under tsx without `@/` resolution.
 */
import type { QualifyPatientCohort } from '../../lib/qualify/contract';

function usd0(n: number): string {
  return `$${Math.round(n).toLocaleString('en-US')}`;
}

function MixList({
  title,
  rows,
  showDollars,
}: {
  title: string;
  rows: QualifyPatientCohort['byPayer'];
  showDollars: boolean;
}) {
  if (rows.length === 0) return null;
  return (
    <div className="px-4 pt-3">
      <h3 className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">{title}</h3>
      <ul className="mt-1.5 space-y-1">
        {rows.map((r, i) => (
          <li key={`${r.label ?? '—'}-${i}`} className="flex items-baseline justify-between gap-2 text-[12.5px]">
            <span className="truncate text-ink900">{r.label ?? '—'}</span>
            <span className="shrink-0 tabular-nums text-muted-foreground">
              {r.count.toLocaleString('en-US')} claims
              {showDollars && r.charge !== null ? ` · ${usd0(r.charge)}` : ''}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function Pct({ label, value }: { label: string; value: number | null }) {
  return (
    <div className="rounded-lg bg-surface px-2.5 py-2 text-center">
      <div className="tabular-nums text-[15px] font-semibold text-ink900">
        {value === null ? '—' : `${Math.round(value)}%`}
      </div>
      <div className="text-[10px] font-semibold uppercase tracking-wide text-ink400">{label}</div>
    </div>
  );
}

export function CohortSheet({
  data,
  loading,
  patientLabel,
  onClose,
}: {
  /** null while nothing has been requested; render nothing then. */
  data: QualifyPatientCohort | null;
  loading: boolean;
  /** The masked group label ("Patient 3") — never a real name (PHI stays in the table's reveal path). */
  patientLabel: string | null;
  onClose: () => void;
}) {
  if (!loading && data === null) return null;
  const showDollars = data?.viewerHasAmountsCapability === true;
  return (
    <aside
      role="dialog"
      aria-label="Patient cohort context"
      className="fixed inset-y-0 right-0 z-50 flex w-[360px] max-w-full flex-col border-l bg-card shadow-xl"
    >
      <div className="flex items-center justify-between border-b px-4 py-3">
        <h2 className="font-display text-[15px] font-semibold">
          Cohort context{patientLabel ? <span className="ml-2 text-[12px] font-medium text-muted-foreground">· {patientLabel}</span> : null}
        </h2>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close cohort panel"
          className="rounded-md border border-teal200 bg-teal50 px-2 py-0.5 text-[12px] font-semibold text-teal700 hover:bg-teal200"
        >
          Close
        </button>
      </div>

      {loading ? (
        <p className="px-4 py-8 text-center text-sm text-muted-foreground">Loading cohort…</p>
      ) : data!.suppressed ? (
        // The honest floor state — mirrors the collections cohort suppression copy.
        <p className="px-4 py-8 text-center text-sm text-muted-foreground">
          Not enough data — cohort context is shown only for groups of {data!.floor}+ patients.
        </p>
      ) : (
        <div className="overflow-y-auto pb-4">
          <p className="px-4 pt-3 text-[12px] text-muted-foreground">
            Lifetime view of the <span className="font-semibold text-ink900">{data!.patients!.toLocaleString('en-US')}</span>-patient
            member-prefix cohort this patient belongs to.
          </p>
          <div className="grid grid-cols-3 gap-2 px-4 pt-3">
            <Pct label="% allowed" value={data!.pctAllowed} />
            <Pct label="% paid" value={data!.pctPaid} />
            <Pct label="% collected" value={data!.pctCollected} />
          </div>
          <MixList title="Payer mix" rows={data!.byPayer} showDollars={showDollars} />
          <MixList title="CPT mix" rows={data!.byCpt} showDollars={showDollars} />
          <p className="px-4 pt-4 text-[10.5px] leading-snug text-ink400">
            Cohort = members sharing this patient’s ID prefix (their payer-behavior peer group). Aggregates only;
            individual claims stay in the table behind the audited reveal.
          </p>
        </div>
      )}
    </aside>
  );
}
