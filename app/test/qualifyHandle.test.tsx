/**
 * I2 — ONE IDENTIFIER AUTHORITY (Qualify v3 / D3).
 *
 * These tests are written BEFORE the implementation they guard, per §9 of the v3 spec, because this
 * is a failure that has already shipped: `app/lib/qualify/contract.ts` carried TWO functions that
 * classified the same typed input differently.
 *
 *   classifyQualifyIdentifier (CLIENT — drove the compose filter, the count, the grid)
 *     /^[A-Za-z]{1,3}$/ ⇒ prefix, anything else ⇒ exact member id.       "W26" ⇒ MEMBER ID
 *   sniffQualifyKind (SERVER — drove the policy card, ladder, payer resolve, ranking)
 *     trimmed length <= 3 ⇒ prefix.                                      "W26" ⇒ PREFIX
 *
 * So for "W26" the client minted an exact member_id_bidx token that matches NOTHING (no member's
 * complete id is "W26") while the server resolved a policy, a window ladder, a payer and a
 * 28-facility ranking. That is the screenshot where a populated policy card and a rating of 34 sit
 * beside "0 charge lines match · 0 clients · no matches yet".
 *
 * The letters-only rule is the wrong one: real payer alpha-prefixes are overwhelmingly
 * ALPHANUMERIC, so the client's regex broke on most actual insurance cards while XDP and XQH
 * (letters only) happened to work. That is why the bug looked intermittent.
 *
 * The invariant: there is exactly ONE decision function, and every path agrees with it.
 */
import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import {
  classifyQualifyHandle,
  sniffQualifyKind,
  type QualifyMatchKind,
} from '../lib/qualify/contract';

/** Real-shaped handles, per §D3's enumeration. `kind` is what BOTH paths must now agree on. */
const CASES: ReadonlyArray<{
  raw: string;
  kind: QualifyMatchKind | 'empty';
  echo: string;
  why: string;
}> = [
  { raw: 'XDP', kind: 'prefix', echo: 'XDP', why: 'letters-only 3-char prefix — worked under both old rules' },
  { raw: 'XQH', kind: 'prefix', echo: 'XQH', why: 'the other letters-only case from the screenshots' },
  // THE BUG. Alphanumeric 3-char handles are the common real-world shape.
  { raw: 'W26', kind: 'prefix', echo: 'W26', why: 'THE REGRESSION CASE — a digit must not demote a 3-char prefix' },
  { raw: 'W27', kind: 'prefix', echo: 'W27', why: 'second reported alphanumeric prefix' },
  { raw: 'AB1', kind: 'prefix', echo: 'AB1', why: 'qualify-render.test.tsx:805 pinned this as a member id — it is a prefix' },
  { raw: 'W291408212', kind: 'member_id', echo: '', why: 'a real full member id' },
  { raw: 'ABCD', kind: 'member_id', echo: '', why: '4 chars — past the prefix width' },
  { raw: 'AB', kind: 'prefix', echo: 'AB', why: '2 chars is still a prefix narrow, not an exact id' },
  // Mixed case + surrounding whitespace must not change the KIND.
  { raw: '  w26  ', kind: 'prefix', echo: 'w26', why: 'whitespace trimmed, case preserved, kind unchanged' },
  { raw: 'w291408212', kind: 'member_id', echo: '', why: 'lowercase full id is still a full id' },
  { raw: '', kind: 'empty', echo: '', why: 'no term is neither narrow — must be representable' },
  { raw: '   ', kind: 'empty', echo: '', why: 'whitespace-only is empty, not a 3-char prefix' },
];

test('I2: every real-shaped handle classifies to exactly one kind', () => {
  for (const c of CASES) {
    const got = classifyQualifyHandle(c.raw);
    assert.equal(got.kind, c.kind, `${JSON.stringify(c.raw)} → ${c.kind} (${c.why}), got ${got.kind}`);
    assert.equal(got.echo, c.echo, `${JSON.stringify(c.raw)} echo`);
  }
});

test('I2: client and server agree — the two-authority divergence is unrepresentable', () => {
  for (const c of CASES) {
    if (c.kind === 'empty') continue; // sniffQualifyKind has no empty case; the handle reader does
    const server = sniffQualifyKind(c.raw);
    const authority = classifyQualifyHandle(c.raw).kind;
    assert.equal(
      server,
      authority,
      `${JSON.stringify(c.raw)}: sniffQualifyKind said ${server}, the authority said ${authority} — ` +
        'this is the exact divergence D3 removes',
    );
  }
});

test('I2: the echo is PREFIX-SAFE — a full member id is never echoed back', () => {
  // The echo is what the screen may render and what may live in component state. A prefix (<=3
  // chars) is non-PHI by the existing contract; a full member id is PHI and must never leave the
  // classifier. If this ever returns the raw id, the "how we read your input" line becomes a PHI
  // disclosure surface.
  for (const raw of ['W291408212', 'ABCD', 'w291408212', '123456789012']) {
    const got = classifyQualifyHandle(raw);
    assert.equal(got.kind, 'member_id');
    assert.equal(got.echo, '', `member-id echo must be empty, got ${JSON.stringify(got.echo)}`);
    assert.ok(!got.readAs.includes(raw), 'readAs must not embed the member id either');
  }
});

test('I2: readAs states HOW the input was read, in plain language, without the value', () => {
  const prefix = classifyQualifyHandle('W26');
  assert.match(prefix.readAs, /prefix/i, 'a prefix reading says so');
  assert.match(prefix.readAs, /3/, 'and names the width the user typed');

  const member = classifyQualifyHandle('W291408212');
  assert.match(member.readAs, /member id/i, 'a member-id reading says so');

  const empty = classifyQualifyHandle('');
  assert.ok(empty.readAs.length > 0, 'even the empty reading is stateable');

  // readAs is rendered to the screen and may reach a provenance string, so it must be non-dollar and
  // non-PHI for every role — I4's byte-identical requirement depends on it carrying no value.
  for (const c of CASES) {
    const { readAs } = classifyQualifyHandle(c.raw);
    if (c.kind === 'member_id') {
      assert.ok(!readAs.includes(c.raw.trim()), `readAs leaked the member id for ${JSON.stringify(c.raw)}`);
    }
  }
});

test('I2: a full member id that happens to be 3 characters reads as a prefix, and that is SAFE', () => {
  // §D3 calls this case out explicitly. Under the single authority a 3-char id classifies as a
  // prefix — deliberately. A prefix search on the full id is a SUPERSET of the exact search (the
  // 3-char prefix of a 3-char id IS the id), so the member is still found. The old client rule would
  // have minted an exact token and found the member too, but only for letters; for "AB1" it minted an
  // exact token against a prefix index and found nothing. Prefix-as-superset never loses a row.
  const got = classifyQualifyHandle('AB1');
  assert.equal(got.kind, 'prefix');
  assert.equal(got.echo, 'AB1');
});
