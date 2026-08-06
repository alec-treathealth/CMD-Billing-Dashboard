/**
 * Qualify FINDINGS — the CCR-Agent `FlagCard` idea ported: a finding anchored to the claim it is
 * about, carrying its own cited evidence, instead of a verdict the reader has to take on trust.
 *
 * WHAT THIS IS NOT: new information. Every line below is DERIVED from a snapshot the client already
 * holds — factor readings, sample counts, provenance, the window ladder, the LOS basis. There is no
 * server change and no contract change (contract.ts semantics are frozen). The score already showed
 * its work in `detail`; what was missing is that the reader had to assemble "is this number
 * trustworthy?" from three places at once — the factor row, the confidence tier elsewhere on the
 * card, and the provenance banner above the list.
 *
 * WHY DERIVE RATHER THAN SHIP STRUCTURED EVIDENCE ON THE WIRE: the evidence for a factor is mostly
 * facts about the SEARCH (which window the ladder chose, whether the ranking is a comparable cohort,
 * how many patients) rather than facts about the factor. Those already ride the snapshot. Putting a
 * denormalized copy on every factor would create two sources for one truth and a contract change to
 * keep them in step.
 *
 * PHI / AMOUNTS: percentages, counts, day counts, enums and date strings only — the same invariant
 * the rating itself carries — so an admissions_seat session derives an IDENTICAL finding list. Never
 * put a dollar figure in a finding; it would split the blind and sighted views.
 */
import type { QualifyFacility, QualifySnapshot } from './contract';
import { PROVENANCE_LABELS, type QualifyFactorReading } from './ratingV2';
import { QUALIFY_RATING_CONFIDENT_PATIENTS, QUALIFY_RATING_MIN_PATIENTS } from './sampleGate';

/**
 * 'watch' — the factor IS measured and is dragging the score down. An actionable negative.
 * 'gap'   — the factor could NOT be measured. Borrowed from CCR's needs_review: an absence stated
 *           plainly is worth more than a silent omission, because the reader would otherwise assume
 *           the score covered something it did not.
 */
export type QualifyFindingSeverity = 'watch' | 'gap';

export interface QualifyFinding {
  /** The factor this is anchored to — the card renders it beneath that row, never in a side panel. */
  factorKey: QualifyFactorReading['key'];
  severity: QualifyFindingSeverity;
  /** One line, the claim itself. */
  title: string;
  /** The factor's own server-computed sentence, verbatim — never paraphrased client-side. */
  rationale: string;
  /** Cited support. Each entry is a fact already on the snapshot, labelled with where it came from. */
  evidence: Array<{ label: string; value: string }>;
}

/** How thin the sample is, in the repo's existing patient-count vocabulary (sampleGate's 3 / 10). */
function sampleEvidence(f: QualifyFacility): { label: string; value: string } {
  const n = f.distinctPatients;
  const qualifier =
    n < QUALIFY_RATING_MIN_PATIENTS
      ? ' — below the floor to score'
      : n < QUALIFY_RATING_CONFIDENT_PATIENTS
        ? ' — thin'
        : '';
  return { label: 'Sample', value: `${n} distinct patient${n === 1 ? '' : 's'}${qualifier}` };
}

/**
 * Findings for ONE facility, ordered most-actionable first: measured negatives before absences.
 *
 * A positive or neutral factor produces nothing. This list is deliberately allowed to be empty — a
 * facility with no negatives and no gaps should render no findings at all, not a reassuring
 * placeholder. An empty state that congratulates itself is the same class of noise as the census
 * alarm that fired on all 23 facilities.
 */
export function deriveFacilityFindings(f: QualifyFacility, snap: QualifySnapshot): QualifyFinding[] {
  const findings: QualifyFinding[] = [];
  const windowSpan = snap.ladder ? `${snap.ladder.chosenDays}d` : null;

  for (const factor of f.factors) {
    // MEASURED NEGATIVE — the factor scored and the score is pulling the rating down.
    if (factor.available && factor.direction === 'neg') {
      const evidence: Array<{ label: string; value: string }> = [
        { label: 'Weight', value: `${factor.weight} of 100, renormalized over ${f.availableWeight} available` },
        sampleEvidence(f),
      ];
      if (windowSpan) evidence.push({ label: 'Window', value: `${windowSpan}, chosen by the sufficiency ladder` });
      if (snap.provenance !== 'direct') {
        evidence.push({ label: 'Evidence base', value: PROVENANCE_LABELS[snap.provenance] });
      }
      findings.push({
        factorKey: factor.key,
        severity: 'watch',
        title: `${factor.label} is pulling this score down`,
        rationale: factor.detail,
        evidence,
      });
      continue;
    }

    // UNMEASURED — say so, and say what it costs. An unavailable factor is renormalized away, which
    // means the headline number describes LESS than the reader assumes unless the card admits it.
    if (!factor.available) {
      findings.push({
        factorKey: factor.key,
        severity: 'gap',
        title: `${factor.label} could not be measured`,
        rationale: factor.detail,
        evidence: [
          { label: 'Effect on the score', value: `${factor.weight} points renormalized away, not scored as zero` },
          { label: 'Scored on', value: `${f.availableWeight} of 100 weighting` },
        ],
      });
    }
  }

  // Measured negatives first: something you can act on outranks something we could not see.
  return findings.sort((a, b) => (a.severity === b.severity ? 0 : a.severity === 'watch' ? -1 : 1));
}
