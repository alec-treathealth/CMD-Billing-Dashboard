/**
 * Qualify SEARCH TRACE — what this search actually did, and why.
 *
 * Ported from CCR-Agent's `AgentActivity` ("reads like a colleague narrating their chart pull, not a
 * terminal") with ONE deliberate change of meaning, stated here so nobody mistakes it later:
 *
 *   CCR narrates a genuinely streaming backend, so its feed is live. `getQualifySnapshot` is a
 *   SINGLE round trip that returns everything at once — there is no progress to observe. A feed that
 *   revealed these lines on timers would be theatre: it would imply the system was working through
 *   steps at moments when it had already finished, and this surface's entire posture is that it does
 *   not manufacture what it cannot measure. So this is a RETROSPECTIVE trace, rendered from the
 *   finished snapshot, and the UI labels it that way rather than dressing a spinner.
 *
 * It still earns its place. The search makes decisions the ranked list cannot explain by itself: it
 * widened the window and that cost confidence; it picked one payer out of several; it ranked a
 * comparable cohort because this policy has no claims of its own. Those are exactly the questions an
 * operator asks after seeing a number they did not expect, and today the answers are scattered
 * across four components.
 *
 * PURE + DERIVED: every line comes from the snapshot already on the client. No new server data, no
 * contract change. Counts, day counts, enums and labels only — never a dollar — so the trace is
 * byte-identical for an admissions_seat session.
 */
import { scopedPayerOf, type QualifySnapshot } from './contract';
import { PROVENANCE_LABELS } from './ratingV2';

/** 'ok' reads as settled, 'note' as a decision worth knowing, 'flag' as something to check. */
export type QualifyTraceTone = 'ok' | 'note' | 'flag';

export interface QualifyTraceLine {
  tone: QualifyTraceTone;
  text: string;
}

/**
 * The trace for a resolved snapshot, in the order the search actually resolved things: identity,
 * then the policy behind it, then the window decision, then the payer, then what got ranked.
 *
 * Returns [] when there is nothing to narrate (no identifier resolved and no policy on file) — an
 * empty search should render nothing rather than a line saying it found nothing, which the empty
 * state above it already says better.
 */
export function deriveSearchTrace(snap: QualifySnapshot): QualifyTraceLine[] {
  const lines: QualifyTraceLine[] = [];
  const policy = snap.policy;

  // ── the policy on file ─────────────────────────────────────────────────────────────────────
  if (policy?.found) {
    lines.push({
      tone: 'ok',
      text: `${policy.memberCount.toLocaleString('en-US')} verified member${policy.memberCount === 1 ? '' : 's'} on file behind this prefix`,
    });
    // The spread, if the prefix is not one plan. Measured: 80.5% of member-weighted searches land on
    // a multi-employer prefix, so this line is the common case, not the exception.
    if (policy.carrierCount > 1 || policy.employerCount > 1) {
      const parts = [
        policy.carrierCount > 1 ? `${policy.carrierCount} carriers` : null,
        policy.employerCount > 1 ? `${policy.employerCount} employers` : null,
      ].filter((s): s is string => s !== null);
      lines.push({ tone: 'flag', text: `Not one plan — ${parts.join(' and ')} behind it; the chips show the most common` });
    }
    if (policy.vobStale) {
      lines.push({ tone: 'flag', text: `VOB feed is stale — nothing new since ${policy.vobFreshAsOf ?? 'an unknown date'}` });
    }
  }

  // ── the window decision ────────────────────────────────────────────────────────────────────
  if (snap.ladder) {
    const chosen = snap.ladder.chosenDays;
    const rung = snap.ladder.rungs.find((r) => r.days === chosen);
    if (!snap.ladder.sufficient) {
      lines.push({
        tone: 'flag',
        text: `Even ${chosen}d never reached a confident sample — widest window used, and confidence is scored down for it`,
      });
    } else if (chosen > 30) {
      lines.push({
        tone: 'note',
        text: `Widened to ${chosen}d to reach ${rung ? rung.distinctPatients : 'a confident'} patient${rung && rung.distinctPatients === 1 ? '' : 's'} — a wider window costs data confidence`,
      });
    } else {
      lines.push({ tone: 'ok', text: `30d was already enough — ${rung ? rung.distinctPatients : 'a confident'} patients in window` });
    }
  }

  // ── the payer ──────────────────────────────────────────────────────────────────────────────
  if (snap.payerOptions.length > 1) {
    const total = snap.payerOptions.reduce((s, o) => s + o.lines, 0);
    // ALL-PAYERS gets its own line, not a variant of the payer-scoped one. "Ranked under X (62% of
    // claim lines)" is a scope CLAIM, and after the identifier-wide Skip it is false in both halves:
    // there is no single X, and the ranking covers 100% of the lines, not the dominant label's share.
    // `scopedPayerOf` is what makes that unmissable — this file cannot interpolate a label it has not
    // first established exists.
    const scoped = scopedPayerOf(snap.resolved);
    if (scoped === null && snap.resolved !== null) {
      lines.push({
        tone: 'note',
        text: `Ranked across all ${snap.payerOptions.length} payers on file — the chips can scope it to one`,
      });
    } else if (scoped !== null) {
      const active = snap.payerOptions.find((o) => o.payer === scoped) ?? null;
      const share = active && total > 0 ? Math.round((active.lines / total) * 100) : null;
      lines.push({
        tone: snap.payerOverridden ? 'note' : share !== null && share < 50 ? 'flag' : 'ok',
        text: snap.payerOverridden
          ? `Scoped to ${scoped} — your selection, out of ${snap.payerOptions.length} payers on file`
          : `${snap.payerOptions.length} payers on file; ranked under ${scoped}${share !== null ? ` (${share}% of claim lines)` : ''}`,
      });
    }
  }

  // ── what got ranked ────────────────────────────────────────────────────────────────────────
  if (snap.provenance === 'comparable_employer' || snap.provenance === 'comparable_funding') {
    lines.push({
      tone: 'flag',
      text: `No claims for this policy itself — ranked on a comparable cohort (${PROVENANCE_LABELS[snap.provenance]}), so this is an estimate`,
    });
  }
  if (snap.facilities.length > 0) {
    const rated = snap.facilities.filter((f) => f.ratingV2 !== null).length;
    lines.push({
      tone: 'ok',
      text:
        rated === snap.facilities.length
          ? `${snap.facilities.length} facilit${snap.facilities.length === 1 ? 'y' : 'ies'} ranked`
          : `${snap.facilities.length} facilit${snap.facilities.length === 1 ? 'y' : 'ies'} found, ${rated} with enough evidence to score`,
    });
  }

  return lines;
}
