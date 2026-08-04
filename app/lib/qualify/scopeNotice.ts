/**
 * SCOPE HONESTY (2026-08-04) — the Qualify v2 prototype's load-bearing rule, ported as real code:
 * everything on screen must describe the SAME rows, or say plainly that it does not.
 *
 * The bug this exists to kill: a searched alpha prefix resolves to a PAYER, the facility ranking is
 * then fetched payer-wide (`getQualifySnapshotByPayer` — it never sees the identifier), while the
 * charge-line grid filters BY that identifier. The screen therefore showed 27 ranked facilities with
 * $148,638 allowed next to "No charge lines match these filters" and "$0 billed" — three numbers
 * about three different populations, presented as one read. A rep on the phone cannot tell that the
 * ranking is not their client's history. That is a confident wrong answer, which this surface holds
 * to be worse than an honest "not enough data".
 *
 * PURE + CLIENT-SAFE, and NON-DOLLAR by construction: counts, labels and percentages only, so an
 * admissions_seat session derives the identical notice.
 */
import type { QualifyFacility } from './contract';

export type QualifyScopeTone = 'info' | 'warn';

export interface QualifyScopeNotice {
  tone: QualifyScopeTone;
  /** One line the rep reads first — states WHAT the ranking is about. */
  headline: string;
  /** Why the two populations differ, and what to do about it. */
  detail: string;
}

/**
 * The population a ranking represents. `payer` is the direct path (the payer's own claims);
 * the two cohort kinds are the `comparable_*` provenances, where the ranking is an ESTIMATE built
 * from similar plans rather than this policy's history — and the copy has to say so, because the
 * whole honesty rule on this surface is that an estimate is never dressed as direct evidence.
 */
export type QualifyRankingScope =
  | { kind: 'payer'; label: string | null }
  | { kind: 'employer_cohort' }
  | { kind: 'funding_cohort' };

/** How each scope reads mid-sentence ("These 27 facilities are …"). */
function scopePhrase(scope: QualifyRankingScope): string {
  switch (scope.kind) {
    case 'payer':
      return `${scope.label ?? 'this payer'}-wide`;
    case 'employer_cohort':
      return 'an ESTIMATE from employers like this one';
    case 'funding_cohort':
      return 'an ESTIMATE from plans funded like this one';
  }
}

/** What the ranking actually describes, for the explanatory second sentence. */
function scopeSource(scope: QualifyRankingScope): string {
  switch (scope.kind) {
    case 'payer':
      return `how ${scope.label ?? 'this payer'} pays us generally`;
    case 'employer_cohort':
      return 'how peer employers behave — a cohort estimate, not this policy';
    case 'funding_cohort':
      return 'how similarly-funded plans behave — a cohort estimate, not this policy';
  }
}

export interface DeriveScopeNoticeInput {
  /** Facilities in the ranking on screen. */
  rankedCount: number;
  /** Charge lines matching the FULL composed filter. Null = not loaded yet — say nothing. */
  composedCount: number | null;
  /** True when the compose bar carried a PHI identifier (alpha prefix / member id / client name),
   *  which is the case where the ranking's population and the grid's population diverge hardest. */
  identifierSearched: boolean;
  /** WHAT the ranking is actually a ranking OF. Not just a label: on the comparable-provenance paths
   *  the ranking is a peer COHORT, not the payer's own claims, and calling that "AETNA-wide" is
   *  factually wrong — it is an estimate assembled from similar plans. The three kinds read
   *  differently on purpose (Qodo review, 2026-08-04). */
  rankingScope: QualifyRankingScope;
  /** Human window label ("30d", "Jul 2026") — quoted back so the rep can act on it. */
  windowLabel: string;
}

/**
 * The notice to render between the readout and the ranking, or null when the screen is already
 * self-consistent. Deliberately silent while data is in flight: a scope warning that flashes on
 * every keystroke teaches the rep to ignore scope warnings.
 */
export function deriveScopeNotice(input: DeriveScopeNoticeInput): QualifyScopeNotice | null {
  const { rankedCount, composedCount, identifierSearched, rankingScope, windowLabel } = input;
  if (composedCount === null) return null; // still loading — never speak before the data does
  if (rankedCount === 0) return null; // no ranking on screen, nothing to misread
  const phrase = scopePhrase(rankingScope);
  const source = scopeSource(rankingScope);
  const facilityWord = rankedCount === 1 ? 'facility' : 'facilities';

  if (composedCount === 0) {
    // The contradiction case. The ranking is showing numbers; the grid has nothing.
    return identifierSearched
      ? {
          tone: 'warn',
          headline: `These ${rankedCount} ${facilityWord} are ${phrase} — not this client's history.`,
          detail:
            `This client has no charge lines in the ${windowLabel} window, so nothing below is evidence about ` +
            `their policy: it is ${source}. Widen the window, or ask a biller before you quote anything.`,
        }
      : {
          tone: 'warn',
          headline: `${rankedCount} ${facilityWord} ranked, but no charge lines match your filters.`,
          detail:
            `The ranking is ${phrase} for the ${windowLabel} window; your other filters — facility, employer, ` +
            `funding, setting — narrow only the rows. Remove one to see the claims behind these ratings.`,
        };
  }

  if (identifierSearched) {
    // Both populations have data, but they are still not the same population. State it once, quietly.
    return {
      tone: 'info',
      headline: `Ranking is ${phrase}; the rows below are this client's own claims.`,
      detail:
        `Two different populations, both for the ${windowLabel} window — the ratings are ${
          rankingScope.kind === 'payer' ? 'payer behaviour' : 'a cohort estimate'
        }, not this policy's track record.`,
    };
  }

  return null;
}

/**
 * "ON FILE" TAGS — the prototype's policy tag row. What the plan behind the searched prefix actually
 * IS, so the rep reasons about coverage instead of guessing: carrier · funding · policy type · plan
 * type · network.
 *
 * PHI BOUNDARY, deliberate and narrow: these five are plan-level facts (the registry-adjacent
 * non-PHI tier). `employerName` is NOT included even though the policy card carries it — an employer
 * plus a facility plus a date range narrows to a person, and the query-library allowlist has never
 * let employer_name reach a model or a log. `groupOnFile` is a presence flag by contract (the raw
 * group number exists only as a blind index and can never be displayed), so it is not rendered here
 * either. No benefit dollars: deductible/oopMax are dollar-bearing and already stripped for
 * admissions_seat, so putting them on a shared bar would make the bar role-dependent.
 *
 * A missing value renders "not on file" rather than being dropped, because on this surface "we did
 * not capture the network" and "in network" are different answers and must not look alike.
 * `network` in particular is ALWAYS null today (the VOB extractor does not carry it — Phase D), so
 * this row is where that gap becomes visible instead of being silently absent.
 */
export interface QualifyOnFileTag {
  label: string;
  value: string;
  missing: boolean;
  /** Render in the mono/tabular face (codes, not prose). */
  mono: boolean;
}

export interface DeriveOnFileTagsInput {
  carrier: string | null;
  funding: string | null;
  policyType: string | null;
  planType: string | null;
  network: 'INN' | 'OON' | null;
}

export function deriveOnFileTags(policy: DeriveOnFileTagsInput | null): QualifyOnFileTag[] {
  if (!policy) return [];
  const tag = (label: string, raw: string | null, mono = false): QualifyOnFileTag => {
    const value = raw === null || raw.trim() === '' ? null : raw.trim();
    return { label, value: value ?? 'not on file', missing: value === null, mono };
  };
  return [
    tag('Payer', policy.carrier),
    tag('Funding', policy.funding),
    tag('Policy', policy.policyType),
    tag('Plan', policy.planType),
    tag('Network', policy.network, true),
  ];
}

/**
 * The KPI flanks (the prototype's `spreadFor`): the facilities that SET the range on the same metric
 * the headline tile averages. A tile that averages a set it cannot also bracket is the parts
 * contradicting the whole — this is what stops that.
 *
 * Uses `pctAllowedOfBilled`, which is a percentage and therefore present for every role.
 * Null when fewer than two facilities carry the metric: a "range" over one facility is not a range.
 */
export interface QualifySpreadEnd {
  label: string;
  /** Whole percent, already rounded for display. */
  value: number;
  who: string;
}

export interface QualifyFacilitySpread {
  worst: QualifySpreadEnd;
  best: QualifySpreadEnd;
}

export function deriveFacilitySpread(facilities: readonly QualifyFacility[]): QualifyFacilitySpread | null {
  const scored = facilities.filter(
    (f): f is QualifyFacility & { pctAllowedOfBilled: number } => f.pctAllowedOfBilled !== null,
  );
  if (scored.length < 2) return null;
  let lo = scored[0]!;
  let hi = scored[0]!;
  for (const f of scored) {
    if (f.pctAllowedOfBilled < lo.pctAllowedOfBilled) lo = f;
    if (f.pctAllowedOfBilled > hi.pctAllowedOfBilled) hi = f;
  }
  // A flat set (every facility identical) is not a spread worth two columns.
  if (lo.pctAllowedOfBilled === hi.pctAllowedOfBilled) return null;
  return {
    worst: { label: 'Worst', value: Math.round(lo.pctAllowedOfBilled), who: lo.name },
    best: { label: 'Best', value: Math.round(hi.pctAllowedOfBilled), who: hi.name },
  };
}
