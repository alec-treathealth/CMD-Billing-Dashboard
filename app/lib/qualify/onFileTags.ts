/**
 * "ON FILE" TAGS — the readout bar's policy tag row. What the plan behind the searched prefix actually
 * IS, so the rep reasons about coverage instead of guessing: payer · employer · funding · policy type ·
 * plan type · network.
 *
 * PHI BOUNDARY, deliberate and narrow.
 *
 * `employerName` IS included — Alec's ruling, 2026-08-04: the employer is a factor of the search and
 * belongs on screen when a prefix resolves. It was already rendered by the policy strip, so withholding
 * it here made the two summaries of one policy disagree for no benefit. The scope of that ruling is
 * DISPLAY to an authenticated Qualify principal, which is what this surface exists for. It does NOT
 * license the other two paths: employer must still never reach a model prompt (the QualifyAiInput schema
 * has no field for it, structurally) or a log line, and `employer_norm` being written to the URL query
 * string — where it reaches browser history, Referer and edge logs — is a separate open question,
 * because a URL escapes the authenticated surface and a rendered chip does not.
 *
 * Still excluded, for reasons the ruling does not touch: `groupOnFile` is a presence flag by contract
 * (the raw group number exists only as a blind index and can never be displayed), and the four benefit
 * strings are dollar-bearing and already stripped for admissions_seat, so putting them on a shared bar
 * would make the bar role-dependent.
 *
 * A missing value renders "not on file" rather than being dropped, because on this surface "we did not
 * capture the network" and "in network" are different answers and must not look alike. `network` in
 * particular is ALWAYS null today (the VOB extractor does not carry it — Phase D), so this row is where
 * that gap becomes visible instead of being silently absent.
 *
 * PURE + CLIENT-SAFE and non-dollar, so blind and sighted roles render the identical row.
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
  employerName: string | null;
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
    // Second, not last: after the payer this is the fact the rep most needs, and on a self-funded
    // plan it names who actually decides an exception.
    tag('Employer', policy.employerName),
    tag('Funding', policy.funding),
    tag('Policy', policy.policyType),
    tag('Plan', policy.planType),
    tag('Network', policy.network, true),
  ];
}
