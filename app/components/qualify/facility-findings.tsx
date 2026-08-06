'use client';

/**
 * FacilityFindings — CCR-Agent's `FlagCard` idea for the Qualify card: a finding anchored to the
 * claim it is about, carrying its cited evidence, rather than a verdict the reader must trust.
 *
 * WHY ANCHORED AND NOT A PANEL: the score already showed its work in each factor's `detail`, but
 * "is this number trustworthy?" required assembling the factor row, the confidence tier, the
 * provenance banner and the window ladder from four places on screen. A finding puts the claim and
 * its support in one block, under the factor it belongs to.
 *
 * READ-ONLY BY DESIGN (ruled 2026-08-06). No acknowledge, no dismiss, no persistence — CCR forces a
 * resolution note because it is producing a medical record that gets signed; Qualify is an
 * exploration surface and a dismiss button here would need a table, a writer path and an audit row
 * to answer a question nobody has asked yet.
 *
 * Pure/presentational (no hooks) so it renders hermetically under renderToStaticMarkup. Non-dollar
 * by construction — the derivation carries counts, day counts and enums only, so this block is
 * byte-identical for an admissions_seat session.
 */
import type { QualifyFinding } from '../../lib/qualify/findings';

const SEVERITY_META: Record<QualifyFinding['severity'], { label: string; chip: string; rule: string }> = {
  // Measured and dragging the score down — actionable, so it carries the warmer tone.
  watch: { label: 'Watch', chip: 'border-status-warn/30 bg-status-warn/10 text-status-warn', rule: 'border-status-warn/30' },
  // Could not be measured. Neutral, NOT alarming: an honest absence is not a defect, and colouring
  // it like one would train the reader to ignore both.
  gap: { label: 'No data', chip: 'border-line bg-surface text-ink400', rule: 'border-line' },
};

export function FacilityFindings({ findings }: { findings: QualifyFinding[] }) {
  // Deliberately silent when there is nothing to report. A facility with no negatives and no gaps
  // renders no block at all — a reassuring placeholder would be noise, and this session already
  // spent a day on an alarm that fired on every facility and therefore meant nothing.
  if (findings.length === 0) return null;

  return (
    <div className="mt-2 space-y-2" data-testid="facility-findings">
      {findings.map((fi) => {
        const meta = SEVERITY_META[fi.severity];
        return (
          <div key={`${fi.factorKey}-${fi.severity}`} className={['rounded-xl border-l-2 bg-ground px-3 py-2.5', meta.rule].join(' ')}>
            <div className="flex flex-wrap items-center gap-2">
              <span className={['inline-flex items-center rounded-full border px-2 py-0.5 text-[10px] font-bold', meta.chip].join(' ')}>
                {meta.label}
              </span>
              <b className="text-[12.5px] font-semibold leading-snug text-ink900">{fi.title}</b>
            </div>
            {/* The server-computed sentence, verbatim — never paraphrased on the client. */}
            <p className="mt-1 text-[11.5px] leading-relaxed text-ink600">{fi.rationale}</p>
            {fi.evidence.length > 0 ? (
              <dl className="mt-2 space-y-1 rounded-lg bg-surface px-2.5 py-2">
                <dt className="text-[9.5px] font-bold uppercase tracking-[0.1em] text-ink400">Evidence</dt>
                {fi.evidence.map((e) => (
                  <dd key={e.label} className="text-[11px] leading-snug text-ink600">
                    <span className="font-semibold text-ink900">{e.label}</span>
                    <span aria-hidden> · </span>
                    <span className="tabular-nums">{e.value}</span>
                  </dd>
                ))}
              </dl>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}
