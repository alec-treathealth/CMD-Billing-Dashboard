/**
 * Qualify v3 — `CoverageGroup` and `QualifyResolution`: the ONE population authority (D2 / P2).
 *
 * WHAT PROBLEM THIS SOLVES. v2 modelled a search as AND-composed filters over charge lines and then
 * reverse-engineered a *policy* out of whatever matched. Measured consequence: four panels on one
 * screen answered "what is allowed of billed" with 31% / 45% / 49% / 40, each describing a DIFFERENT
 * population, none saying so. The KPI tiles were scoped by payer+facility chips but never by the
 * prefix; the window ladder counted everyone sharing a prefix across all payers and then silently
 * re-windowed every other panel; the ranking was payer-wide by construction.
 *
 * The fix is structural, not a caption pass: ONE server-derived object carries the population, the
 * window, the predicate identity and the per-panel evidence. Every rendered number traces to it, and
 * no panel builds its own filter. Honesty stops being something you remember to caption and becomes
 * something the types make hard to get wrong.
 *
 * THREE PROPERTIES THAT ARE NOT NEGOTIABLE, each enforced by a test rather than a convention:
 *
 *  1. NON-DOLLAR THROUGHOUT (I4). An `admissions_seat` session is server-stripped of every dollar
 *     field, so a resolution containing one would make blind and sighted sessions derive DIFFERENT
 *     provenance strings — the exact leak `test/qualifyCoreV2.test.ts` exists to prevent. There is no
 *     amount, charge, billed, allowed or paid field anywhere in these types. `hasReliableAllowed` is
 *     a BOOLEAN about data quality, not a value.
 *  2. NO PHI IN ANYTHING RENDERABLE (I7). `handle.echo` is prefix-only (a full member id is never
 *     echoed); `employerKey` is opaque and positional; `employerLabel` is display-only. None of the
 *     three may reach `urlState` or any URL builder.
 *  3. NULL IS NOT ZERO (I5). Every derived figure that can be unknown is `| null`, and "cannot say"
 *     renders differently from "zero". A 0% that means "we don't know" is the confidently-wrong
 *     failure this surface has repeatedly held to be worse than an honest blank.
 *
 * Pure module: no server imports, no I/O, no query builders. Client components may import it.
 */

// ── Panels ───────────────────────────────────────────────────────────────────────────────────────

/** The panels a resolution can back. Each renders a provenance line naming the subset it used. */
export type PanelId = 'kpis' | 'ranking' | 'policy' | 'ladder' | 'trend' | 'ai';

/**
 * What ONE panel was actually built on. `subset` is rendered verbatim as that panel's provenance
 * line, so it must be non-PHI and non-dollar for every role.
 *
 * `scope` is the load-bearing field. 'resolution' means the panel is about the chosen coverage group.
 * 'book_wide' means it is NOT — the KPI tiles are ratified book-wide (see the ledger), and the honest
 * reading of "every number traces to one resolution" is that the tile's PROVENANCE comes from the
 * resolution and states the tile is not about this client. Traceability is the requirement; identical
 * scoping is not.
 */
export interface PanelEvidence {
  scope: 'resolution' | 'book_wide';
  /** Distinct members behind this panel's figures, or null when the panel is not member-grained. */
  members: number | null;
  /** Charge lines behind this panel's figures, or null when not line-grained. */
  lines: number | null;
  /** True when the panel is rendering with less evidence than its own floor requires. */
  belowFloor: boolean;
  /** The provenance sentence. Rendered SERVER-side so blind and sighted roles get identical bytes. */
  subset: string;
}

// ── CoverageGroup ────────────────────────────────────────────────────────────────────────────────

/** How a group's payer identity was established. Ordered loosely strongest → weakest. */
export type ResolutionBasis =
  /** The VOB row's `payer_id` spine resolved to one canonical — no name guessing involved. */
  | 'vob_payer_id'
  /** The VOB `insurance_co` string matched a CONFIRMED alias. */
  | 'vob_name'
  /** Only the claims-side `primary_payer` string matched a CONFIRMED alias. */
  | 'claims_name'
  /** A routing program (BlueCard): the real payer is the member's home plan, resolved per member. */
  | 'program_label_per_member'
  /** No VOB row exists for this member at all — the group is claims evidence only (§3d). */
  | 'claims_only';

export type PayerRelationship =
  | 'same_payer'
  | 'program_label'
  | 'carve_out'
  | 'tpa'
  | 'employer_self_funded'
  | 'unmapped';

/**
 * Claim evidence behind a candidate, in the `sampleGate` idiom (3 / 10 distinct patients).
 *
 * ⚠ `distinctPatients` and `distinctMembers` are THE SAME MEASURE TODAY, deliberately and visibly.
 * `collections.cmd_explorer_charge_rollup` carries `member_id_bidx` but no patient token — migration
 * 0067 would add `patient_name_bidx` and is unapplied (gated on a name backfill). Presenting them as
 * two independent counts would imply corroboration that does not exist. Both fields are kept because
 * the sample gate speaks in patient-count idiom and the ranking speaks in member-count idiom, and
 * collapsing them would hide the seam when 0067 lands.
 */
export interface ClaimEvidence {
  distinctMembers: number;
  lines: number;
  distinctFacilities: number;
  distinctPatients: number;
  /** `sampleGate` tier. 'insufficient' (<3) suppresses a rating entirely — see ratingV2. */
  sampleTier: 'insufficient' | 'thin' | 'ok';
  /**
   * Whether allowed-amount data is trustworthy enough to rate on. A BOOLEAN, never a dollar figure —
   * this is what lets a blind role derive the identical rating.
   */
  hasReliableAllowed: boolean;
}

/**
 * One resolvable population: a real payer, optionally narrowed by plan sponsor and plan shape.
 *
 * CROSS-TENANT BY CONSTRUCTION. `memberCount` and every `claimEvidence` figure count across BOTH
 * BXR (`af504ab6…`) and Indigo (`141d459c…`) together. This is Qualify's ratified exception, not a
 * new decision — the single-`business_entity_id` pattern used elsewhere in the app is WRONG here, and
 * a query in this path scoped to one entity is a deviation to stop and report, not to write.
 */
export interface CoverageGroup {
  /** null ⇒ UNMAPPED. Renders as unmapped, never as a match (I8). */
  canonicalPayerId: string | null;
  payerDisplayName: string;
  payerRelationship: PayerRelationship;
  /** For a carve-out or TPA: who actually administers the benefit. */
  administratorId: string | null;
  administratorName: string | null;
  resolutionBasis: ResolutionBasis;
  /**
   * OPAQUE plan-sponsor key. Positional within one resolution (`emp_1`, `emp_2`, …) — deliberately
   * NOT a hash of the employer name. `employer_name` is listed in `app/lib/phi.ts`
   * `PHI_BASE_COLUMNS`, and employer names are low-entropy, so an unkeyed hash of one is reversible
   * by dictionary. A positional token carries zero information outside its own payload, cannot be
   * correlated across sessions, and needed no new crypto. It must never reach a URL (I7).
   */
  employerKey: string | null;
  /** Display only. Never a URL, never a log, never the model prompt. */
  employerLabel: string | null;
  funding: 'Self-Funded' | 'Fully Insured' | null;
  planType: string | null;
  policyType: string | null;
  /**
   * INN / OON. **Always null today** — the VOB PDFs do not carry it and the extraction work is
   * cross-repo (`etl/vob`). Kept VISIBLE rather than omitted: a missing field the UI can say
   * "not captured on this VOB" about is honest; a field quietly absent from the type reads as
   * "not applicable".
   */
  network: 'INN' | 'OON' | null;
  /** PRESENCE only — never the group number itself, which is PHI behind a blind index. */
  groupOnFile: boolean;
  /**
   * CLAIMS-SIDE `primary_payer` labels confirmed (alias map) to belong to this group's canonical
   * payer WITHIN this identifier's own rows, ranked by line count (top 3). Non-PHI — payer labels
   * are companies. Populated only on the CHOSEN group (one bounded query on the critical path);
   * empty for rejected candidates, unmapped groups, and groups with no in-window claims. The answer
   * stage passes [0] as the snapshot `payerOverride` so the facility ranking is scoped to the payer
   * the user actually picked — without this bridge the ranking silently reverts to the identifier's
   * dominant payer under a header naming the picked one (the PR #92 scope-honesty defect class).
   */
  claimsPayerLabels: string[];
  /** Distinct members in VOB on this group. Cross-tenant. */
  memberCount: number;
  /** ISO date of the freshest VOB row in the group, or null when there is no VOB row. */
  vobFreshAsOf: string | null;
  vobStale: boolean;
  claimEvidence: ClaimEvidence;
}

/** A rejected candidate, kept so the screen can show what was NOT chosen. Same non-dollar rule. */
export interface CoverageGroupSummary {
  canonicalPayerId: string | null;
  payerDisplayName: string;
  employerLabel: string | null;
  funding: 'Self-Funded' | 'Fully Insured' | null;
  planType: string | null;
  memberCount: number;
  /** So the UI can mark a no-evidence candidate BEFORE the user picks it (§S1). */
  hasClaimEvidence: boolean;
}

// ── Window ───────────────────────────────────────────────────────────────────────────────────────

export type QualifyWindowKindV3 = 'trailing' | 'calendar_month' | 'calendar_year';

/** One rung of the ladder proposal, counted over THE CHOSEN GROUP — not everyone sharing a prefix. */
export interface QualifyWindowRung {
  days: number;
  label: string;
  members: number;
  lines: number;
}

export interface QualifyWindowLadder {
  rungs: QualifyWindowRung[];
  /** The rung the ladder would propose. The user still confirms it (§5d) — this is advice, not an act. */
  proposedDays: number;
  /** Why this rung: stated so the proposal is never a silent re-window. */
  rationale: string;
}

/**
 * The ONE window authority. `frozen` is the invariant that matters (I6): once results render, the
 * window does not change except by user action. v2's ladder auto-changed it from a count the user
 * never saw, which invalidated every panel on screen without announcing anything.
 */
export interface ResolvedWindow {
  from: string;
  to: string;
  kind: QualifyWindowKindV3;
  chosenBy: 'user' | 'ladder_proposal_confirmed';
  ladder: QualifyWindowLadder | null;
  frozen: boolean;
}

// ── Notices ──────────────────────────────────────────────────────────────────────────────────────

export type QualifyNoticeKind =
  | 'unmapped_payer'
  | 'no_policy_on_file'
  | 'ambiguous_candidates'
  | 'sole_candidate'
  | 'thin_evidence'
  | 'stale_vob'
  | 'network_not_captured';

/** A thing the screen must SAY, not imply. `text` is non-PHI, non-dollar, server-rendered. */
export interface QualifyNotice {
  kind: QualifyNoticeKind;
  severity: 'info' | 'caution';
  text: string;
}

// ── QualifyResolution ────────────────────────────────────────────────────────────────────────────

export interface ResolvedHandle {
  kind: 'prefix' | 'member_id' | 'facility' | 'employer' | 'payer';
  /** Plain-language reading, from the ONE identifier authority. Never contains the value. */
  readAs: string;
  /** PREFIX-SAFE echo. '' for a member id — a full member id is PHI and is never echoed. */
  echo: string;
}

export interface ResolvedCandidates {
  total: number;
  chosenIndex: number;
  /** True whenever `total > 1`. The screen must SAY a choice was made (§5b). */
  wasAmbiguous: boolean;
  chosenBy: 'user' | 'sole_candidate';
  rejected: CoverageGroupSummary[];
}

/**
 * The single object every rendered number traces to.
 *
 * `predicateId` is the identity of the row predicate, expressed ONCE. Two panels showing the same
 * `predicateId` are provably about the same rows; two that differ are provably not. It is a
 * non-PHI digest of the resolved scope — never the scope itself, because the scope contains blind
 * index tokens.
 */
export interface QualifyResolution {
  handle: ResolvedHandle;
  group: CoverageGroup;
  candidates: ResolvedCandidates;
  window: ResolvedWindow;
  predicateId: string;
  evidence: Record<PanelId, PanelEvidence>;
  /** Rendered SERVER-side, so blind and sighted sessions receive identical bytes (I4). */
  provenance: Record<PanelId, string>;
  unmapped: boolean;
  /** §3d first-class: ~35% of members have no VOB row. Not a fallback — a designed state. */
  policyOnFile: boolean;
  notices: QualifyNotice[];
}

// ── Pure derivations ─────────────────────────────────────────────────────────────────────────────

/** Positional, opaque, payload-scoped. See `CoverageGroup.employerKey` for why not a hash. */
export function employerKeyFor(index: number): string {
  return `emp_${index + 1}`;
}

/**
 * Sample tier in the `sampleGate` idiom. Thresholds 3 / 10 DISTINCT PATIENTS, matching
 * `app/lib/qualify/sampleGate.ts` — claims within a patient share one plan, contract and CPT pattern,
 * so they are not independent draws and line counts overstate the sample roughly 23×.
 */
export function sampleTierFor(distinctPatients: number): ClaimEvidence['sampleTier'] {
  if (distinctPatients < 3) return 'insufficient';
  if (distinctPatients < 10) return 'thin';
  return 'ok';
}

/** True when the freshest VOB row in a group is older than the staleness horizon. */
export const VOB_STALE_DAYS = 180;

export function isVobStale(vobFreshAsOf: string | null, today: string): boolean {
  if (!vobFreshAsOf) return false; // no VOB row is "no policy on file", NOT "stale" — different states
  const a = Date.parse(`${vobFreshAsOf}T00:00:00Z`);
  const b = Date.parse(`${today}T00:00:00Z`);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return false;
  return (b - a) / 86_400_000 > VOB_STALE_DAYS;
}

/**
 * The provenance sentence for one panel. SERVER-rendered and byte-identical for every role, because
 * it is built only from counts, enums and names — never a dollar figure and never a PHI value.
 */
export function panelProvenance(panel: PanelId, ev: PanelEvidence, group: CoverageGroup): string {
  if (ev.scope === 'book_wide') {
    // The ratified wording. Do not soften it: the tile is deliberately NOT about this client, and
    // saying so is the whole reason option 2 was chosen over resolution-scoping.
    return 'book-wide, not this client';
  }
  const who = group.canonicalPayerId === null ? 'an unmapped payer' : group.payerDisplayName;
  const emp = group.employerLabel ? ` · ${group.employerLabel}` : '';
  const bits: string[] = [];
  if (ev.members !== null) bits.push(`${ev.members.toLocaleString()} member${ev.members === 1 ? '' : 's'}`);
  if (ev.lines !== null) bits.push(`${ev.lines.toLocaleString()} charge line${ev.lines === 1 ? '' : 's'}`);
  const counts = bits.length > 0 ? ` · ${bits.join(' · ')}` : '';
  const floor = ev.belowFloor ? ' · below the evidence floor' : '';
  return `${who}${emp}${counts}${floor}`;
}

/**
 * Notices for a resolved group. Every one of these is a thing v2 left the user to infer.
 *
 * Order is deliberate: the states that INVALIDATE the screen come first.
 */
export function deriveNotices(
  group: CoverageGroup,
  candidates: ResolvedCandidates,
  today: string,
): QualifyNotice[] {
  const out: QualifyNotice[] = [];
  if (group.canonicalPayerId === null) {
    out.push({
      kind: 'unmapped_payer',
      severity: 'caution',
      text:
        'This payer name does not map to a known payer yet, so it is shown as unmapped. ' +
        'Facility comparisons for it are not available.',
    });
  }
  if (group.resolutionBasis === 'claims_only') {
    out.push({
      kind: 'no_policy_on_file',
      severity: 'info',
      text: 'No verification of benefits on file for this member — this is claims history only.',
    });
  }
  if (candidates.total > 1) {
    out.push({
      kind: 'ambiguous_candidates',
      severity: 'caution',
      text: `${candidates.total} plans match what you typed. You are seeing the one you selected.`,
    });
  } else if (candidates.total === 1 && candidates.chosenBy === 'sole_candidate') {
    // §11(3), ruled: a sole candidate auto-advances AND the screen states it was unambiguous —
    // because "only one plan matched" is real information, not the absence of a question.
    out.push({
      kind: 'sole_candidate',
      severity: 'info',
      text: 'Only one plan matched what you typed, so it was selected for you.',
    });
  }
  if (group.claimEvidence.sampleTier === 'insufficient') {
    out.push({
      kind: 'thin_evidence',
      severity: 'caution',
      text:
        `Only ${group.claimEvidence.distinctPatients} patient${group.claimEvidence.distinctPatients === 1 ? '' : 's'} ` +
        'of history here — too few to rate a facility on.',
    });
  }
  if (isVobStale(group.vobFreshAsOf, today)) {
    out.push({
      kind: 'stale_vob',
      severity: 'caution',
      text: `The benefits on file were captured ${group.vobFreshAsOf} and may be out of date.`,
    });
  }
  if (group.network === null && group.resolutionBasis !== 'claims_only') {
    out.push({
      kind: 'network_not_captured',
      severity: 'info',
      text: 'In-network status is not captured on this VOB.',
    });
  }
  return out;
}

/**
 * Window reducer — the state machine I6 tests.
 *
 * The rule: after results render, the ONLY thing that may change the window is a user action. A
 * ladder proposal arriving late, a candidate re-resolving, a count landing — none of them may move it.
 * v2 re-windowed from a count the user never saw, which invalidated every panel silently.
 */
export type WindowAction =
  | { type: 'propose'; ladder: QualifyWindowLadder }
  | { type: 'confirm_proposal' }
  | { type: 'user_set'; from: string; to: string; kind: QualifyWindowKindV3 }
  | { type: 'results_rendered' };

export function windowReducer(state: ResolvedWindow, action: WindowAction): ResolvedWindow {
  switch (action.type) {
    case 'propose':
      // A proposal attaches; it never applies. Frozen or not, the window itself does not move.
      return { ...state, ladder: action.ladder };
    case 'confirm_proposal': {
      if (!state.ladder) return state;
      const days = state.ladder.proposedDays;
      const to = state.to;
      const from = shiftIsoDays(to, -days);
      // Confirming IS a user action, so it is allowed even once frozen — the user is the exception.
      return { ...state, from, to, kind: 'trailing', chosenBy: 'ladder_proposal_confirmed' };
    }
    case 'user_set':
      return { ...state, from: action.from, to: action.to, kind: action.kind, chosenBy: 'user' };
    case 'results_rendered':
      return { ...state, frozen: true };
    default:
      return state;
  }
}

/** ISO date arithmetic in UTC, matching `contract.ts`'s trailing-window convention. */
export function shiftIsoDays(iso: string, days: number): string {
  const t = Date.parse(`${iso}T00:00:00Z`);
  if (!Number.isFinite(t)) return iso;
  const d = new Date(t + days * 86_400_000);
  return d.toISOString().slice(0, 10);
}
