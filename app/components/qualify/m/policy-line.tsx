'use client';

/**
 * Qualify mobile — the COMPACT policy line (Phase I parity with desktop's policy-strip.tsx).
 * One dense row under the search header, not a card: carrier · funding · plan type · network chip,
 * plus the two banners that change what the list MEANS:
 *   - vobStale (red): the VOB snapshot behind the card is older than the freshness bar.
 *   - estimated provenance (amber): the ranked list below is a comparable cohort, not this
 *     policy's own claims — the same honesty rule as desktop, at phone width.
 * Amounts-blind by construction: benefit dollar strings (deductible/OOP) are NEVER rendered here —
 * phone screens are the shared-in-a-hallway surface, so the compact line carries plan shape only.
 * Employer name is likewise omitted (desktop shows it; the phone line stays identifier-free).
 */
import type { QualifyPolicyCard } from '../../../lib/qualify/contract';
import { PROVENANCE_LABELS, type QualifyProvenance } from '../../../lib/qualify/ratingV2';

const INK400 = '#63756E';

export function MobilePolicyLine({
  policy,
  provenance,
}: {
  policy: QualifyPolicyCard | null;
  provenance: QualifyProvenance;
}) {
  const estimated = provenance === 'comparable_employer' || provenance === 'comparable_funding';
  if (!policy?.found && !estimated) return null;

  const chips: string[] = [];
  if (policy?.found) {
    // Desktop parity (2026-08-06): a bare carrier chip asserts the prefix has ONE carrier, and
    // member-weighted that is false for 86.8% of searches. The suffix is the whole disclosure at
    // phone width — no room for desktop's spread sentence, but silence here would be the same lie.
    if (policy.carrier) chips.push(policy.carrierCount > 1 ? `${policy.carrier} · 1 of ${policy.carrierCount}` : policy.carrier);
    if (policy.funding) chips.push(policy.funding === 'SELF' ? 'Self-funded' : policy.funding === 'FULLY' ? 'Fully insured' : policy.funding);
    if (policy.planType) chips.push(policy.planType);
  }

  return (
    <div style={{ padding: '8px 16px 0' }}>
      {policy?.found ? (
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
          <span style={{ fontSize: 9, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.08em', color: INK400 }}>VOB</span>
          {chips.map((c) => (
            <span
              key={c}
              style={{ fontSize: 10.5, fontWeight: 600, color: '#1B2B2A', background: '#EEF2F0', borderRadius: 999, padding: '2px 8px' }}
            >
              {c}
            </span>
          ))}
          {policy.network === 'INN' ? (
            <span style={{ fontSize: 10.5, fontWeight: 700, color: '#2E8B6F', background: '#EAF3EE', borderRadius: 999, padding: '2px 8px' }}>INN</span>
          ) : policy.network === 'OON' ? (
            <span style={{ fontSize: 10.5, fontWeight: 700, color: '#C9881E', background: '#FBF1E0', borderRadius: 999, padding: '2px 8px' }}>OON</span>
          ) : null}
        </div>
      ) : null}
      {policy?.found && policy.vobStale ? (
        <div style={{ marginTop: 6, fontSize: 11, fontWeight: 600, color: '#C0453B', background: '#FBEAEA', borderRadius: 10, padding: '6px 10px' }}>
          VOB data is stale — treat benefits as unverified until the next sync.
        </div>
      ) : null}
      {estimated ? (
        <div style={{ marginTop: 6, fontSize: 11, fontWeight: 600, color: '#8A5A10', background: '#FBF1E0', borderRadius: 10, padding: '6px 10px' }}>
          Estimated — {PROVENANCE_LABELS[provenance]}. No paid claims for this policy yet.
        </div>
      ) : null}
    </div>
  );
}
