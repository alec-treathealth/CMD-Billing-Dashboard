/**
 * "Ask about this policy" — chip derivation (2026-08-04): the Qualify v2 mockup's chipsFor()
 * ported onto the real snapshot contract. PURE + CLIENT-SAFE: reads only the QualifySnapshot the
 * panel already holds, so chip selection is deterministic and hermetically testable, and an
 * admissions_seat session derives the identical chip set (nothing here touches a dollar field).
 *
 * The mockup's principle carries over verbatim: every candidate is conditional on something THIS
 * search actually returned — a self-funded OON EPO raises different questions than an in-network
 * PPO — so no two policies offer the same five. Most-specific-first; FIVE shown (ruled 2026-08-04;
 * the mockup showed six). Two mockup chips are deliberately absent:
 *   'slide' (steepest-decline) — RULED OUT: no faithful per-facility trend exists behind the 0050
 *     rollup (ruling Q-E, the same root cause as the deferred streak badge). No new trend work.
 *   'pay' ("what does this policy actually pay us?") — a dollar question; this surface is
 *     dollar-free by construction for every role.
 *
 * Field mappings vs the mockup (each verified against contract.ts, 2026-08-04):
 *   pol.patients   → the chosen ladder rung's distinctPatients (the policy-level sample the window
 *                    actually ran on); fallback = sum of facility distinctPatients when the ladder
 *                    is absent (manual Range / no-identifier paths).
 *   pol.policy     → policy.policyType (modal PPO/EPO/… — planType is the finer plan text).
 *   pol.network    → policy.network — ALWAYS null today (Phase D gap: not extracted from the VOB);
 *                    the network chip and the OON-suggested rule light up the moment it lands.
 *   pol.funding    → policy.funding ('Self-Funded' | 'Fully Insured', raw VOB casing).
 *   scoped         → exactly one ranked facility (the payer-level panel has no facility selection;
 *                    a single-facility set is the real analogue of the mockup's facility scope).
 *   subject        → facilities[0] (rank-1; the list is ORDER BY rating desc, ruling Q-G).
 *   f.conflict     → a facility whose available factors disagree: at least one 'pos' AND one 'neg'
 *                    (the mockup's "reliability carries it, aging drags it" shape).
 */
import type { QualifyFacility, QualifySnapshot } from './contract';
import { QUALIFY_RATING_CONFIDENT_PATIENTS } from './sampleGate';
import type { QualifyAiInput } from '../../../src/collections/qualifyAi';

export type QualifyAiChipId = QualifyAiInput['question'];

export interface QualifyAiChip {
  id: QualifyAiChipId;
  label: string;
}

export interface QualifyAiChipSet {
  chips: QualifyAiChip[];
  /** The one chip the numbers most make worth asking (ruled table, 2026-08-04). May name a chip the
   *  candidate list did not surface (e.g. 'ranks' on a scoped, unrated search) — the mockup behaves
   *  the same way, and the panel simply highlights nothing in that case. */
  suggestedId: QualifyAiChipId;
}

/** Ruled 2026-08-04: five shown (the mockup showed six). */
export const QUALIFY_AI_CHIP_COUNT = 5;

/** The speed chip flips to "pays slowly" phrasing when even the FASTEST facility's median paid-line
 *  days-to-payment exceeds this (conservative: one fast facility keeps the neutral phrasing). */
export const QUALIFY_AI_SLOW_DAYS = 100;

/** IQ 'Solid' floor — "strong" for the nothing-strong/takeit branch, same 50 the mockup used. */
const STRONG_RATING_FLOOR = 50;

function hasDirection(f: QualifyFacility, direction: 'pos' | 'neg'): boolean {
  return f.factors.some((x) => x.available && x.direction === direction);
}

/** Factor readings that disagree — a live positive AND a live negative on the same facility. */
function inConflict(f: QualifyFacility): boolean {
  return hasDirection(f, 'pos') && hasDirection(f, 'neg');
}

/** Policy-level distinct patients: the chosen ladder rung when the ladder ran, else the facility
 *  sum (a patient seen at two facilities counts twice there — acceptable for a >=10 threshold). */
function policyPatients(snapshot: QualifySnapshot): number {
  const ladder = snapshot.ladder;
  if (ladder) {
    const rung = ladder.rungs.find((r) => r.days === ladder.chosenDays);
    if (rung) return rung.distinctPatients;
  }
  return snapshot.facilities.reduce((sum, f) => sum + f.distinctPatients, 0);
}

export function qualifyAiChips(snapshot: QualifySnapshot): QualifyAiChipSet {
  const facilities = snapshot.facilities;
  const scoped = facilities.length === 1;
  const subject = facilities[0] ?? null;
  const policy = snapshot.policy?.found ? snapshot.policy : null;

  const anyRated = facilities.some((f) => f.ratingV2 !== null);
  const nothingStrong =
    anyRated && !facilities.some((f) => f.ratingV2 !== null && f.ratingV2 >= STRONG_RATING_FLOOR);
  const thin = policyPatients(snapshot) < QUALIFY_RATING_CONFIDENT_PATIENTS;
  const policyType = policy?.policyType?.trim().toUpperCase() ?? null;
  const narrow = policyType === 'EPO' || policyType === 'HMO';
  const network = policy?.network ?? null;
  const funding = policy?.funding?.trim().toLowerCase() ?? null;
  const selfFunded = funding !== null && funding.startsWith('self');
  const fullyInsured = funding !== null && funding.startsWith('fully');
  const medians = facilities
    .map((f) => f.medianDaysToPayment)
    .filter((d): d is number => d !== null);
  const slow = medians.length > 0 && Math.min(...medians) > QUALIFY_AI_SLOW_DAYS;
  const anyNegative = facilities.some((f) => hasDirection(f, 'neg'));

  // Most specific first — the mockup's order, minus the two ruled-out chips. The head slot is
  // EXCLUSIVE (explain XOR ranks), a deliberate mockup semantic: v1 showed both unconditionally.
  const candidates: Array<QualifyAiChip | false> = [
    scoped
      ? { id: 'explain', label: 'Why does this facility score what it does?' }
      : anyRated
        ? { id: 'ranks', label: 'Which of our facilities does this policy pay best?' }
        : { id: 'explain', label: 'What do we actually know about this policy?' },
    thin && { id: 'thin', label: 'Is there even enough history to trust this?' },
    nothingStrong && !thin && { id: 'takeit', label: 'Should we be taking this policy at all?' },
    anyRated &&
      !nothingStrong && {
        id: 'placement',
        label: scoped ? 'Should I place this client here?' : 'Where should this client go?',
      },
    narrow && { id: 'plantype', label: `${policyType} plan — is there any path to payment?` },
    network === 'OON' && {
      id: 'network',
      label: 'We are out of network here — what does that cost us?',
    },
    network === 'INN' && {
      id: 'network',
      label: 'In network on this plan — are we billing the full rate?',
    },
    selfFunded && { id: 'funding', label: 'Self-funded plan — who actually decides this claim?' },
    fullyInsured && { id: 'funding', label: 'Fully insured — how much room is there to negotiate?' },
    medians.length > 0 && {
      id: 'speed',
      label: slow ? 'This pays slowly — how slowly?' : 'How long until we see the money?',
    },
    anyNegative && { id: 'improve', label: 'What would move this rating?' },
  ];

  const seen = new Set<QualifyAiChipId>();
  const chips: QualifyAiChip[] = [];
  for (const candidate of candidates) {
    if (!candidate || seen.has(candidate.id)) continue;
    seen.add(candidate.id);
    chips.push(candidate);
    if (chips.length === QUALIFY_AI_CHIP_COUNT) break;
  }

  // Ruled table (2026-08-04): scoped+unrated→ranks · scoped+conflict→explain · scoped+rated→
  // placement · unscoped+OON→network · else→ranks.
  const suggestedId: QualifyAiChipId =
    scoped && subject
      ? subject.ratingV2 === null
        ? 'ranks'
        : inConflict(subject)
          ? 'explain'
          : 'placement'
      : network === 'OON'
        ? 'network'
        : 'ranks';

  return { chips, suggestedId };
}
