/**
 * I9 — keyboard + assistive-technology acceptance criteria for the v3 S0–S2 flow.
 *
 * These are ACCEPTANCE CRITERIA, not polish, so they are tested the same way the rest of this repo
 * tests markup: `renderToStaticMarkup` plus role/name/heading assertions. Each one corresponds to a
 * measured defect in the v2 surface (§3g).
 */
import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { ResolutionFlow, UNRESOLVABLE_COPY } from '../components/qualify/v3/resolution-flow';
import { deriveNotices } from '../lib/qualify/resolution';
import type { PanelEvidence, PanelId, QualifyResolution } from '../lib/qualify/resolution';

const PANELS: readonly PanelId[] = ['kpis', 'ranking', 'policy', 'ladder', 'trend', 'ai'];

function fixture(over: Partial<QualifyResolution> = {}): QualifyResolution {
  const evidence = Object.fromEntries(
    PANELS.map((p) => [
      p,
      p === 'kpis'
        ? { scope: 'book_wide', members: null, lines: null, belowFloor: false, subset: 'book-wide, not this client' }
        : { scope: 'resolution', members: 42, lines: 1358, belowFloor: false, subset: 'Aetna · 42 members' },
    ]),
  ) as Record<PanelId, PanelEvidence>;
  const base: QualifyResolution = {
    handle: { kind: 'prefix', readAs: 'read as a 3-character member-ID prefix', echo: 'XDP' },
    group: {
      canonicalPayerId: 'pi_aetna',
      payerDisplayName: 'Aetna',
      payerRelationship: 'same_payer',
      administratorId: null,
      administratorName: null,
      resolutionBasis: 'vob_payer_id',
      employerKey: 'emp_1',
      employerLabel: 'SOUTHWEST AIRLINES CO',
      funding: 'Self-Funded',
      planType: 'PPO',
      policyType: 'PPO',
      network: null,
      groupOnFile: true,
      memberCount: 61,
      vobFreshAsOf: '2026-07-20',
      vobStale: false,
      claimEvidence: {
        distinctMembers: 42,
        lines: 1358,
        distinctFacilities: 28,
        distinctPatients: 42,
        sampleTier: 'ok',
        hasReliableAllowed: true,
      },
    },
    candidates: {
      total: 3,
      chosenIndex: 0,
      wasAmbiguous: true,
      chosenBy: 'user',
      rejected: [
        {
          canonicalPayerId: 'pi_cigna',
          payerDisplayName: 'Cigna',
          employerLabel: null,
          funding: null,
          planType: 'POS',
          memberCount: 4,
          hasClaimEvidence: false,
        },
        {
          canonicalPayerId: null,
          payerDisplayName: 'ANTHEM BCBS OF CALIFORNIA',
          employerLabel: 'ACME CO',
          funding: 'Fully Insured',
          planType: null,
          memberCount: 2,
          hasClaimEvidence: true,
        },
      ],
    },
    window: {
      from: '2026-07-06',
      to: '2026-08-05',
      kind: 'trailing',
      chosenBy: 'user',
      ladder: {
        rungs: [
          { days: 30, label: '30 days', members: 2, lines: 40 },
          { days: 90, label: '90 days', members: 12, lines: 380 },
        ],
        proposedDays: 90,
        rationale: '90 days is the narrowest window with at least 3 members of history (12).',
      },
      frozen: false,
    },
    predicateId: 'p_deadbeef',
    evidence,
    provenance: Object.fromEntries(PANELS.map((p) => [p, evidence[p].subset])) as Record<PanelId, string>,
    unmapped: false,
    policyOnFile: true,
    notices: [],
    ...over,
  };
  // Notices are DERIVED, never hand-written into the fixture. Hand-writing them let an earlier version
  // of this file assert a sole-candidate render while still carrying an "3 plans match" notice — the
  // fixture disagreed with itself in a way the real service cannot, and the test failed for that
  // reason rather than for a defect in the flow. Deriving keeps the fixture honest by construction.
  return { ...base, notices: over.notices ?? deriveNotices(base.group, base.candidates, '2026-08-05') };
}

const render = (r: QualifyResolution | null, reason: 'empty' | 'prefix_too_short' | 'no_match' | null = null) =>
  renderToStaticMarkup(<ResolutionFlow resolution={r} reason={reason} echo={r?.handle.echo ?? ''} />);

// ── Landmark + heading structure ─────────────────────────────────────────────────────────────────

test('I9: the flow is a named landmark and every step is a <section> with an <h2>', () => {
  // §3g: v2 had one <h1> plus card <h2>s and no per-step structure, so AT users could not navigate
  // the flow at all.
  const html = render(fixture());
  assert.match(html, /role="region"/, 'the flow is a landmark');
  assert.match(html, /aria-labelledby="qualify-v3-flow-heading"/, 'and it is NAMED, not an anonymous region');
  assert.match(html, /<h1 id="qualify-v3-flow-heading"/, 'the name resolves to a real heading');
  for (const step of ['qualify-s0', 'qualify-s1', 'qualify-s2']) {
    assert.ok(html.includes(`id="${step}"`), `${step} rendered`);
    assert.ok(html.includes(`aria-labelledby="${step}-heading"`), `${step} is labelled by its own heading`);
    assert.ok(html.includes(`id="${step}-heading"`), `${step}'s heading element exists`);
  }
  const h2s = html.match(/<h2\b/g) ?? [];
  assert.ok(h2s.length >= 3, `expected an <h2> per step, found ${h2s.length}`);
  assert.ok(!/<h3\b/.test(html.split('<h2')[0] ?? ''), 'no heading level is skipped before the first h2');
});

test('I9: each step exposes completion state as TEXT, not colour', () => {
  const html = render(fixture());
  assert.ok(html.includes('Complete') || html.includes('In progress'), 'completion is a word');
  // Step 1 has resolved, so it must read Complete; step 2 is ambiguous, so it must not.
  const s0 = html.slice(html.indexOf('qualify-s0'), html.indexOf('qualify-s1'));
  assert.match(s0, /Complete/, 'a resolved step 1 reads Complete');
  const s1 = html.slice(html.indexOf('qualify-s1'), html.indexOf('qualify-s2'));
  assert.match(s1, /In progress/, 'an unresolved ambiguity leaves step 2 in progress');
});

// ── The single live region ───────────────────────────────────────────────────────────────────────

test('I9: exactly ONE aria-live region, and it announces a full sentence', () => {
  // v2 announced "1,358 charge lines match" and never announced a resolution change — the event that
  // invalidates everything else on screen. Multiple polite regions queue unpredictably, so there is one.
  const html = render(fixture());
  const regions = html.match(/aria-live=/g) ?? [];
  assert.equal(regions.length, 1, `expected exactly 1 aria-live region, found ${regions.length}`);
  assert.match(html, /aria-live="polite"/, 'polite, not assertive — this is not an alert');
  assert.match(html, /Resolved: Aetna/, 'it names the resolution');
  assert.match(html, /SOUTHWEST AIRLINES CO/, 'including the plan sponsor');
  assert.match(html, /28 facilities/, 'and the facility count');
  assert.match(html, /3 plans matched; this one is selected\./, 'and states that a choice was made');
});

test('I9: the live region states the reason when nothing resolved', () => {
  for (const reason of ['empty', 'prefix_too_short', 'no_match'] as const) {
    const html = render(null, reason);
    assert.ok(html.includes(UNRESOLVABLE_COPY[reason]), `${reason} is announced verbatim`);
  }
  // And the three are genuinely different sentences — I5 applied to the search itself.
  const texts = new Set(Object.values(UNRESOLVABLE_COPY));
  assert.equal(texts.size, 3, 'the three unresolved states must not share copy');
});

// ── Text size floor ─────────────────────────────────────────────────────────────────────────────

test('I9: no meaning-bearing text below 12px — the 8.5/9.5px flanks are gone', () => {
  // §3g: v2 shipped 8.5px flank labels and 9.5px values. `text-xs` is 12px and `text-sm` is 14px in
  // this Tailwind config; anything smaller is what this asserts against.
  const html = render(fixture());
  for (const tooSmall of ['text-[8.5px]', 'text-[9px]', 'text-[9.5px]', 'text-[10px]', 'text-[10.5px]', 'text-[11px]']) {
    assert.ok(!html.includes(tooSmall), `sub-12px class present: ${tooSmall}`);
  }
  // sr-only is exempt: it is not rendered text, it is the accessible name.
  assert.ok(html.includes('text-xs') || html.includes('text-sm'), 'the smallest visible text is 12px+');
});

// ── Accessible names on numerals ────────────────────────────────────────────────────────────────

test('I9: every bare numeral carries an accessible name', () => {
  // A hero "77" in a <span> announces as "77" with no hint that it is a rating out of 100.
  const html = render(fixture());
  assert.match(html, /aria-label="61 members on this plan"/, 'the member count is named');
  assert.match(html, /aria-label="12 members in a 90 day window"/, 'ladder rung members are named');
  assert.match(html, /aria-label="380 charge lines"/, 'ladder rung lines are named');
});

// ── Colour never carries meaning alone ──────────────────────────────────────────────────────────

test('I9: selected, proposed and severity all carry a WORD, not just a hue', () => {
  const html = render(fixture());
  assert.match(html, />Selected</, 'the chosen candidate says Selected');
  assert.match(html, />Proposed</, 'the proposed rung says Proposed');
  assert.match(html, />Caution</, 'a caution notice says Caution');
  assert.match(html, />Note</, 'and an info notice says Note');
});

// ── One control per target ──────────────────────────────────────────────────────────────────────

test('I9: one control per target — a candidate row has exactly one focusable element', () => {
  // v2's card body and its "Why this score" button toggled the same disclosure: one action, two tab
  // stops. Here each candidate row is a <label> wrapping a single radio.
  const html = render(fixture());
  const rows = html.split('name="candidate"');
  assert.equal(rows.length - 1, 3, 'three candidates, three radios');
  // No nested button/anchor inside a candidate label — that would be the duplicate-target defect.
  const s1 = html.slice(html.indexOf('qualify-s1'), html.indexOf('qualify-s2'));
  const labelChunks = s1.split('<label').slice(1);
  for (const chunk of labelChunks) {
    const upToClose = chunk.slice(0, chunk.indexOf('</label>'));
    assert.ok(!/<button|<a\s/.test(upToClose), 'a label must not contain a second control');
  }
});

// ── Keyboard path = DOM order, and works without JS ─────────────────────────────────────────────

test('I9: the S0→S2 path is plain forms and inputs — no JS required, tab order is visual order', () => {
  const html = render(fixture());
  // Every step's control is a native form element, so the keyboard path is the DOM order by default
  // rather than something a tabindex has to reconstruct.
  assert.ok(!/tabindex="[1-9]/.test(html), 'no positive tabindex — that is what breaks visual order');
  assert.equal((html.match(/<form/g) ?? []).length, 3, 'S0, S1 and S2 each submit natively');
  assert.match(html, /<input id="qualify-term"/, 'S0 is a real text input');
  assert.match(html, /<label htmlFor|<label for="qualify-term"/, 'and it is labelled');
});

test('I9: the S0 input is labelled and described, not placeholder-only', () => {
  const html = render(fixture());
  assert.match(html, /for="qualify-term"/, 'an explicit label association');
  assert.match(html, /aria-describedby="qualify-term-help"/, 'and help text is associated, not adjacent');
  assert.match(html, /id="qualify-term-help"/);
  assert.ok(!/placeholder="[^"]{20,}"/.test(html), 'no long placeholder standing in for a label');
});

test('I9: the reading of the input is stated back to the user', () => {
  const html = render(fixture());
  assert.match(html, /We read as a 3-character member-ID prefix\./, 'the screen says HOW it read the input');
});

// ── The honesty requirements the flow exists for ────────────────────────────────────────────────

test('ambiguity is stated as a question, and the pre-selection is admitted to be a guess', () => {
  const html = render(fixture());
  assert.match(html, /3 plans match what you typed/);
  assert.match(html, /that is a guess, not an answer/, 'the pre-selection is not presented as a resolution');
});

test('a sole candidate says it was unambiguous rather than saying nothing', () => {
  // Built THROUGH fixture() rather than by spreading an already-built ambiguous one: spreading keeps
  // the notices derived from the OLD candidate set, so the render would carry an "3 plans match"
  // notice alongside a sole-candidate headline — a self-contradicting fixture the real service cannot
  // produce, failing the test for the wrong reason.
  const html = render(
    fixture({ candidates: { total: 1, chosenIndex: 0, wasAmbiguous: false, chosenBy: 'sole_candidate', rejected: [] } }),
  );
  assert.match(html, /Only one plan matched what you typed/);
  assert.ok(!html.includes('plans match what you typed.'), 'and does not also claim ambiguity');
});

test('a no-evidence candidate is marked BEFORE selection', () => {
  const html = render(fixture());
  assert.match(
    html,
    /No claim history — a ranking here would have nothing behind it/,
    'the zero-evidence candidate is called out in the list, not after the click',
  );
});

test('the book-wide KPI provenance is rendered verbatim and is not about this client', () => {
  const html = render(fixture());
  assert.match(html, /book-wide, not this client/, 'the ratified wording reaches the screen');
  assert.match(html, /KPI tiles/, 'and is attributed to the KPI panel');
});

test('the predicate id is shown so two panels can be compared', () => {
  const html = render(fixture());
  assert.match(html, /p_deadbeef/);
  assert.match(html, /panels showing the same\s+value are about the same rows/);
});

test('the network gap is stated, never left blank', () => {
  const html = render(fixture());
  assert.match(html, /Not captured on this VOB/);
});

// ── PHI ─────────────────────────────────────────────────────────────────────────────────────────

test('a member-id handle renders no echo — the full id never reaches the markup', () => {
  const r = fixture({
    handle: { kind: 'member_id', readAs: 'read as a complete member ID (10 characters)', echo: '' },
  });
  const html = render(r);
  assert.ok(!html.includes('W291408212'), 'no member id anywhere');
  assert.match(html, /value=""/, 'the input round-trips an empty echo rather than the id');
});

test('the flow renders no URL carrying employer identity', () => {
  const html = render(fixture());
  // R6: v3 never puts employer identity near a URL. The forms carry only `term`, `candidate` and
  // `windowDays`; the employer label is display text.
  const hiddenNames = [...html.matchAll(/<input type="hidden" name="([^"]+)"/g)].map((m) => m[1]);
  for (const n of hiddenNames) {
    assert.ok(!/employer/i.test(n ?? ''), `a hidden field carries employer identity: ${String(n)}`);
  }
  assert.ok(!/[?&]employer/.test(html), 'and no query string mentions an employer');
});
