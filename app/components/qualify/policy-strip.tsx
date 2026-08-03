'use client';

/**
 * Qualify v2 — the RESOLVED POLICY strip (Phase B) + the INN/OON gate (Phase D) + the VOB freshness
 * disclosure (Phase 0). "The alpha prefix IS the policy": the rep types the prefix and the plan on
 * file identifies itself — carrier, employer, funding, plan type — so nothing is re-typed off the
 * card. Pure/presentational (no hooks) so it renders hermetically under renderToStaticMarkup.
 *
 * THE GATE (plan §2) short-circuits the flow rather than weighting it:
 *   INN  → "we already know what we get" — contracted-rate banner; the scorecard below is OON
 *          modeling and reads as context, not the decision.
 *   OON  → the full model runs (no banner needed; OON is Qualify's home case).
 *   null → the full model runs + a quiet "network not captured on this VOB" line. This is EVERY
 *          policy today: the VOB parser does not extract network yet (three live parser
 *          generations, none carries it) — the UI ships the three-way flow so the moment the
 *          extractor lands the gate lights up with zero UI work.
 *
 * FRESHNESS (Phase 0): a stale GLOBAL feed banner — the defence against "confidently wrong". The
 * card also names the policy's own VOB date so the rep sees what vintage of truth they are on.
 *
 * AMOUNTS: deductible/OOP strings render ONLY when the viewer has the amounts capability and the
 * server left them non-null (it nulls them for admissions_seat) — display-only, never scored (§5).
 */
import type { QualifyPolicyCard, QualifyProvenance } from '../../lib/qualify/contract';
import { PROVENANCE_LABELS } from '../../lib/qualify/ratingV2';

function Chip({ label, value, mono = false }: { label: string; value: string | null; mono?: boolean }) {
  const missing = value === null || value.trim() === '';
  return (
    <span
      className={[
        'inline-flex max-w-full items-baseline gap-1.5 rounded-full border px-2.5 py-0.5',
        missing ? 'border-line bg-surface' : 'border-teal200 bg-teal50',
      ].join(' ')}
      title={`${label} · ${missing ? 'not on file' : value} · autofilled from the VOB on file`}
    >
      <span className="shrink-0 text-[9.5px] font-bold uppercase tracking-[0.07em] text-ink400">{label}</span>
      <span
        className={[
          'min-w-0 truncate text-[12px] font-semibold leading-5',
          missing ? 'text-ink400' : 'text-teal700',
          mono ? 'font-mono tabular-nums' : '',
        ].join(' ')}
      >
        {missing ? 'not on file' : value}
      </span>
    </span>
  );
}

export function PolicyStrip({
  policy,
  provenance,
  hasAmounts,
  prefixEcho,
}: {
  policy: QualifyPolicyCard;
  provenance: QualifyProvenance;
  hasAmounts: boolean;
  /** The ≤3-char NON-PHI alpha echo of the searched prefix ('' on non-prefix paths). */
  prefixEcho: string;
}) {
  if (!policy.found) {
    return (
      <section className="rounded-2xl border border-dashed bg-card px-4 py-3 text-[13px] text-muted-foreground shadow-ths-sm">
        <b className="font-semibold text-ink600">No VOB on file</b> behind{' '}
        {prefixEcho ? <span className="font-mono font-semibold">{prefixEcho}</span> : 'this identifier'} — the policy
        can’t identify itself yet. Start a VOB, or ask a biller.
      </section>
    );
  }

  const benefits =
    hasAmounts && (policy.deductible || policy.oopMax)
      ? [
          policy.deductible ? `Deductible ${policy.deductible}${policy.deductibleMet ? ` (met: ${policy.deductibleMet})` : ''}` : null,
          policy.oopMax ? `OOP max ${policy.oopMax}${policy.oopMet ? ` (met: ${policy.oopMet})` : ''}` : null,
        ].filter(Boolean)
      : [];

  return (
    <section className="overflow-hidden rounded-2xl border bg-card shadow-ths-sm" data-testid="policy-strip">
      {/* STALE FEED banner (Phase 0) — loud on purpose: every fact below is suspect when the feed stalls. */}
      {policy.vobStale ? (
        <div className="border-b border-status-danger/30 bg-status-danger/10 px-4 py-2 text-[12px] font-semibold text-status-danger">
          VOB feed is stale — nothing new since {policy.vobFreshAsOf ?? 'an unknown date'}. Policy facts below may be
          out of date; verify before quoting anything.
        </div>
      ) : null}

      {/* THE GATE (Phase D) — three-way. Today network is always null (not extracted yet). */}
      {policy.network === 'INN' ? (
        <div className="border-b border-teal200 bg-teal50 px-4 py-2 text-[12px] font-semibold text-teal700">
          In network on this plan — the contracted rate applies. The facility model below is out-of-network
          modeling; read it as context, not the decision.
        </div>
      ) : null}

      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 px-4 pb-1 pt-3">
        <span className="inline-flex items-center gap-1.5 rounded-full bg-teal900 px-2.5 py-0.5 text-[10.5px] font-semibold text-white">
          Policy on file
        </span>
        <span className="font-head text-[13px] font-semibold tracking-tight text-ink900">
          {prefixEcho ? <span className="font-mono">{prefixEcho}</span> : 'This plan'} identifies itself — nothing to re-type
        </span>
        <span className="ml-auto text-[11px] text-muted-foreground">
          {policy.memberCount.toLocaleString('en-US')} verified member{policy.memberCount === 1 ? '' : 's'} · VOB as of{' '}
          <b className="font-semibold text-ink600">{policy.vobFreshAsOf ?? '—'}</b>
        </span>
      </div>

      <div className="flex flex-wrap items-center gap-1.5 px-4 pb-3 pt-1.5">
        <Chip label="Carrier" value={policy.carrier} />
        <Chip label="Employer" value={policy.employerName} />
        <Chip label="Funding" value={policy.funding} />
        <Chip label="Policy" value={policy.policyType} />
        <Chip label="Plan" value={policy.planType} />
        <Chip label="Group #" value={policy.groupOnFile ? 'on file' : null} mono />
        {policy.network === null ? (
          <span className="ml-1 text-[11px] italic text-ink400" title="The VOB parser does not extract network status yet — the gate lights up the day it does.">
            network not captured on this VOB
          </span>
        ) : policy.network === 'OON' ? (
          <Chip label="Network" value="OON" mono />
        ) : (
          <Chip label="Network" value="INN" mono />
        )}
      </div>

      {/* Self-funded is a MODIFIER + banner, never a factor (§5): who actually decides the claim. */}
      {policy.funding && /self/i.test(policy.funding) ? (
        <p className="border-t border-line px-4 py-2 text-[11.5px] text-ink600">
          <b className="font-semibold">Self-funded plan</b> — {policy.employerName ?? 'the employer'} carries the risk;
          exceptions and single-case agreements are decided by a plan administrator, not a payer rate sheet.
        </p>
      ) : null}

      {benefits.length > 0 ? (
        <p className="border-t border-line px-4 py-2 text-[11.5px] tabular-nums text-ink600">
          {benefits.join(' · ')}
          <span className="ml-1.5 text-[10.5px] italic text-ink400">display only — never part of the score</span>
        </p>
      ) : null}

      {provenance !== 'direct' && provenance !== 'none' ? (
        <p className="border-t border-dashed border-teal200 bg-teal50/50 px-4 py-2 text-[11.5px] font-semibold text-teal700">
          Estimated read: {PROVENANCE_LABELS[provenance]} — directional, not confirmed. This plan has no claims of its
          own yet.
        </p>
      ) : null}
    </section>
  );
}
