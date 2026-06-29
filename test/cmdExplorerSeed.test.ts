/**
 * Hermetic tests for the CMD Explorer seed pipeline (no live DB, no live LLM).
 * Covers the PHI crypto primitives (round-trip, tamper/key-failure throws), the
 * row_fingerprint properties (stability, sensitivity, no field-boundary collision),
 * header validation, and the required-field skip rules in mapRow.
 *
 * The LIBSODIUM_KEY below is a throwaway test key (obvious dummy value) — NOT a real
 * secret. beforeEach sets it so crypto tests are order-independent; the two negative
 * key tests override the env within the test (phiCrypto re-reads + re-derives per call).
 */
import assert from 'node:assert/strict';
import { beforeEach, test } from 'node:test';
import { decryptPhi, encryptPhi, fingerprintRow, PhiCryptoError } from '../src/collections/phiCrypto.js';
import { EXPECTED_HEADERS, headerDiff, mapRow } from '../src/collections/cmdExplorerSeed.js';
import type { CmdExplorerFullRow, CmdExplorerPhi } from '../src/collections/cmdExplorer.js';

/** 32 bytes as 64 hex chars — test-only, not a real key. */
const TEST_KEY = '00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff';

function setKey(value: string | undefined): void {
  if (value === undefined) delete process.env.LIBSODIUM_KEY;
  else process.env.LIBSODIUM_KEY = value;
}

beforeEach(() => setKey(TEST_KEY));

// --- phiCrypto: encrypt / decrypt -------------------------------------------

test('encryptPhi → decryptPhi round-trips plaintext (incl. empty + unicode)', async () => {
  for (const plaintext of ['SMITH, JOHN', 'PGE081', '-11724767', 'GRP 123 / x', '', 'üñîçødé 名前']) {
    const ciphertext = await encryptPhi(plaintext);
    assert.ok(Buffer.isBuffer(ciphertext));
    assert.equal(await decryptPhi(ciphertext), plaintext);
  }
});

test('encryptPhi uses a fresh nonce: same plaintext → different ciphertext, same decrypt', async () => {
  const a = await encryptPhi('SMITH, JOHN');
  const b = await encryptPhi('SMITH, JOHN');
  assert.notEqual(a.toString('hex'), b.toString('hex'));
  assert.equal(await decryptPhi(a), 'SMITH, JOHN');
  assert.equal(await decryptPhi(b), 'SMITH, JOHN');
});

test('decryptPhi throws PhiCryptoError on tampered ciphertext', async () => {
  const ciphertext = await encryptPhi('SMITH, JOHN');
  const tampered = Buffer.from(ciphertext);
  const last = tampered.length - 1;
  tampered[last] = (tampered[last] ?? 0) ^ 0xff; // flip a byte in the ciphertext/MAC region
  await assert.rejects(decryptPhi(tampered), PhiCryptoError);
});

test('decryptPhi throws PhiCryptoError on a too-short buffer', async () => {
  await assert.rejects(decryptPhi(Buffer.alloc(8)), PhiCryptoError);
});

test('encryptPhi throws PhiCryptoError when LIBSODIUM_KEY is missing', async () => {
  setKey(undefined);
  await assert.rejects(encryptPhi('x'), PhiCryptoError);
});

test('encryptPhi throws PhiCryptoError when LIBSODIUM_KEY is the wrong length', async () => {
  setKey('deadbeef'); // 8 hex chars, not 64
  await assert.rejects(encryptPhi('x'), PhiCryptoError);
});

// --- fingerprintRow ---------------------------------------------------------

test('fingerprintRow is stable: identical inputs → identical hex', () => {
  const fields = ['2026-06-21', '2026-06-25', '90853', '0915', 'camh'];
  assert.equal(fingerprintRow(fields), fingerprintRow([...fields]));
});

test('fingerprintRow is sensitive: one changed field → different hex', () => {
  assert.notEqual(fingerprintRow(['a', 'b', 'c']), fingerprintRow(['a', 'b', 'd']));
});

test('fingerprintRow separates fields: ["a","b"] !== ["ab",""] (no boundary collision)', () => {
  assert.notEqual(fingerprintRow(['a', 'b']), fingerprintRow(['ab', '']));
});

test('fingerprintRow returns 64 lowercase hex chars', () => {
  assert.match(fingerprintRow(['x']), /^[0-9a-f]{64}$/);
});

// --- headerDiff -------------------------------------------------------------

test('headerDiff: exact header set → no missing, no extra', () => {
  const diff = headerDiff([...EXPECTED_HEADERS]);
  assert.deepEqual(diff, { missing: [], extra: [] });
});

test('headerDiff: a dropped column is reported as missing', () => {
  const diff = headerDiff(EXPECTED_HEADERS.filter((h) => h !== 'Revenue Code'));
  assert.deepEqual(diff.missing, ['Revenue Code']);
  assert.deepEqual(diff.extra, []);
});

test('headerDiff: an unexpected column is reported as extra', () => {
  const diff = headerDiff([...EXPECTED_HEADERS, 'Surprise Column']);
  assert.deepEqual(diff.missing, []);
  assert.deepEqual(diff.extra, ['Surprise Column']);
});

test('headerDiff: simultaneous missing + extra both reported', () => {
  const actual = [...EXPECTED_HEADERS.filter((h) => h !== 'Facility Name'), 'Facility'];
  const diff = headerDiff(actual);
  assert.deepEqual(diff.missing, ['Facility Name']);
  assert.deepEqual(diff.extra, ['Facility']);
});

// --- mapRow -----------------------------------------------------------------

type RowOverride = Partial<Omit<CmdExplorerFullRow, 'phi'>> & { phi?: Partial<CmdExplorerPhi> };

/** A valid Derek-14-column row (as mapReportRows would emit), with overrides. */
function fullRow(override: RowOverride = {}): CmdExplorerFullRow {
  const { phi: phiOverride, ...rest } = override;
  return {
    rowId: '',
    charge_from_date: '6/21/2026',
    payment_received: '6/25/2026',
    cpt_code: '90853',
    revenue_code: '0915',
    facility: 'CAMH',
    charge_amount: '$1,234.56',
    allowed_amount: '$1,000.00',
    insurance_payments: '$800.00',
    adjustments: '$200.00',
    patient_balance_due: '$34.56',
    primary_payer: 'ANTHEM',
    ...rest,
    phi: {
      patient_name: 'SMITH, JOHN',
      member_id_raw: 'PGE081',
      group_number: 'GRP123',
      ...phiOverride,
    },
  };
}

test('mapRow: a valid row maps ok with normalized values + a 64-hex fingerprint', () => {
  const result = mapRow(fullRow(), 'seed.csv');
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.match(result.row.row_fingerprint, /^[0-9a-f]{64}$/);
    assert.equal(result.row.charge_date, '2026-06-21'); // M/D/YYYY → ISO
    assert.equal(result.row.charge_amount, '1234.56'); //   $1,234.56 → decimal string
    assert.equal(result.row.source_file, 'seed.csv');
  }
});

const skipCases: ReadonlyArray<{ name: string; override: RowOverride; label: string }> = [
  { name: 'blank charge_date', override: { charge_from_date: '' }, label: 'charge_date: missing' },
  { name: 'blank facility', override: { facility: '' }, label: 'facility: missing' },
  { name: 'blank charge_amount', override: { charge_amount: '' }, label: 'charge_amount: missing' },
  { name: 'blank patient_name', override: { phi: { patient_name: '' } }, label: 'patient_name: missing' },
  { name: 'blank member_id', override: { phi: { member_id_raw: '' } }, label: 'member_id: missing' },
];

for (const { name, override, label } of skipCases) {
  test(`mapRow: skips on ${name}`, () => {
    const result = mapRow(fullRow(override), 'seed.csv');
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.label, label);
  });
}

test('mapRow: a null required field (as mapReportRows emits for blanks) skips', () => {
  // facility is still required, so a null facility still skips (proves null-handling).
  const result = mapRow(fullRow({ facility: null }), 'seed.csv');
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.label, 'facility: missing');
});

// cpt_code is no longer required (migration 0020): a blank cell — which mapReportRows
// emits as '' OR null — is persisted with an em-dash (U+2014) placeholder, not skipped.
test('mapRow: blank/null cpt_code maps ok with an em-dash placeholder', () => {
  for (const blank of ['', null] as const) {
    const result = mapRow(fullRow({ cpt_code: blank }), 'seed.csv');
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.row.cpt_code, '—');
      assert.match(result.row.row_fingerprint, /^[0-9a-f]{64}$/);
    }
  }
});
