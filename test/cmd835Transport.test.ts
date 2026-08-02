/**
 * CMD 835 download — TRANSPORT tests.
 *
 * This layer had ZERO coverage, which is how the silent failure survived: the wire
 * contract was guessed (startDate/endDate, a bare Buffer return), and both a quiet day
 * and an undecodable body collapsed to `[]`, so a wrong guess logged success.
 *
 * What these lock:
 *   1) exactly ONE `date` query param reaches the wire — the old startDate/endDate pair
 *      was ignored by CMD, which silently served the wrong day,
 *   2) a quiet day is classified `empty` by EXACT sha256 against KNOWN_EMPTY_DAY_DIGESTS
 *      — never by prose. The original prose matcher matched a DOCUMENTED sentence CMD
 *      does not send, so every quiet day counted as a hard failure (found 2026-07-31),
 *   3) an HTTP 200 whose body is neither a ZIP nor an ALLOWLISTED digest THROWS instead
 *      of masquerading as a quiet day — including a body that reads exactly like a
 *      quiet-day message, which is the anti-silent-swallow guarantee,
 *   4) every thrown error is PHI-safe — endpoint label + status + shape, never body,
 *      URL, or credentials,
 *   5) read835Files still returns [] rather than throwing on unparseable content, so
 *      genuinely quiet days never alarm.
 *
 * Hermetic: `fetchImpl` is injected, no network, no DB.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  CmdEra835Error,
  KNOWN_EMPTY_DAY_DIGESTS,
  MAX_RESPONSE_BYTES,
  bodyDigest,
  classifyBodyShape,
  cmdDownload835,
  read835Files,
  type CmdEra835Config,
} from '../src/collections/cmd835.js';
import {
  blankEra835TenantCounts,
  era835RunStatus,
  newEra835IngestStats,
  recordEra835IngestRun,
  runEra835Ingest,
  seedEra835TenantRoster,
  type Era835DownloadResult,
  type Era835TenantCounts,
} from '../src/ingest/era_ingest.js';
import type { CmdCustomer } from '../src/collections/cmdCustomers.js';

/**
 * The DOCUMENTED no-data wording. As of 2026-07-31 this is NOT classified as empty: CMD
 * never actually sends it, and classification is by exact digest. It is kept as the
 * ideal anti-silent-swallow fixture — a body that reads exactly like a quiet day and
 * still must fail, because its digest is not allowlisted.
 */
const EMPTY_BODY = 'No 835 ERA files were received on that date.';

/** A minimal STORED-mode ZIP. The reader ignores CRC, so the fixture leaves it zero. */
function makeZip(entries: Array<{ name: string; body: string }>): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const { name, body } of entries) {
    const nameBuf = Buffer.from(name, 'utf8');
    const data = Buffer.from(body, 'utf8');

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 8); // method 0 = stored
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0, 10); // method 0 = stored
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt32LE(offset, 42);

    locals.push(local, nameBuf, data);
    centrals.push(central, nameBuf);
    offset += local.length + nameBuf.length + data.length;
  }
  const localPart = Buffer.concat(locals);
  const centralPart = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralPart.length, 12);
  eocd.writeUInt32LE(localPart.length, 16);
  return Buffer.concat([localPart, centralPart, eocd]);
}

const ISA_EDI =
  'ISA*00*          *00*          *ZZ*SUB            *ZZ*RCV            *260101*1200*^*00501*000000001*0*P*:~' +
  'GS*HP*SUB*RCV*20260101*1200*1*X*005010X221A1~ST*835*0001~SE*2*0001~GE*1*1~IEA*1*000000001~';

/** A web ReadableStream over a Buffer, delivered in chunks (the real fetch shape). */
function streamOf(buf: Buffer, chunkSize = 64 * 1024): ReadableStream<Uint8Array> {
  let offset = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (offset >= buf.length) {
        controller.close();
        return;
      }
      const end = Math.min(offset + chunkSize, buf.length);
      controller.enqueue(new Uint8Array(buf.subarray(offset, end)));
      offset = end;
    },
  });
}

/**
 * A body that NEVER ends. This is the case the cap exists for: without a streaming
 * bound, reading it would spin until the process died. The test asserts it throws
 * promptly instead.
 */
function endlessStream(): ReadableStream<Uint8Array> {
  const chunk = new Uint8Array(64 * 1024).fill(0x41);
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      controller.enqueue(new Uint8Array(chunk));
    },
  });
}

interface StubReply {
  status?: number;
  body?: Buffer | string;
  /** Override the Content-Length header (headers lie — used to prove the cap doesn't trust it). */
  contentLength?: string;
  /** Supply a raw stream instead of a fixed body (for the endless case). */
  stream?: ReadableStream<Uint8Array>;
  /** Omit res.body entirely, exercising the arrayBuffer() fallback path. */
  noStream?: boolean;
}

/** Records the URLs it is called with, and replies with a caller-supplied response. */
function stubFetch(reply: () => StubReply) {
  const urls: string[] = [];
  const impl = (async (url: string | URL) => {
    urls.push(String(url));
    const { status = 200, body = '', contentLength, stream, noStream } = reply();
    const bytes = typeof body === 'string' ? Buffer.from(body, 'utf8') : body;
    const headers = new Headers();
    if (contentLength !== undefined) headers.set('content-length', contentLength);
    return {
      ok: status >= 200 && status < 300,
      status,
      headers,
      body: noStream ? null : (stream ?? streamOf(bytes)),
      arrayBuffer: async () =>
        bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
    };
  }) as unknown as typeof fetch;
  return { urls, impl };
}

function cfg(
  fetchImpl: typeof fetch,
  extra?: number | Partial<CmdEra835Config>,
): CmdEra835Config {
  const overrides: Partial<CmdEra835Config> =
    extra === undefined ? {} : typeof extra === 'number' ? { maxBytes: extra } : extra;
  return {
    baseUrl: 'https://webapi.example.test',
    customerId: '10025030',
    auth: { kind: 'basic', username: 'u', password: 'p' },
    fetchImpl,
    ...overrides,
  };
}

// --- 1. the wire contract ----------------------------------------------------

test('cmdDownload835 sends exactly one `date` param — never startDate/endDate', async () => {
  // Body is a real ZIP so the call SUCCEEDS: this test is about the query string, and
  // EMPTY_BODY is no longer a success case (its digest is not allowlisted — see §2).
  const { urls, impl } = stubFetch(() => ({ body: makeZip([{ name: 'a.835', body: ISA_EDI }]) }));
  await cmdDownload835(cfg(impl), { date: '2026-03-04' });

  assert.equal(urls.length, 1);
  const url = new URL(urls[0]!);
  assert.equal(url.pathname, '/v1/customer/10025030/payment/download-835');
  assert.equal(url.searchParams.get('date'), '2026-03-04');
  // The old guess. CMD ignores unknown params, so leaving these on pulled the WRONG DAY.
  assert.equal(url.searchParams.get('startDate'), null);
  assert.equal(url.searchParams.get('endDate'), null);
  assert.deepEqual([...url.searchParams.keys()], ['date']);
});

test('cmdDownload835 rejects a non-ISO date before opening a connection', async () => {
  const { urls, impl } = stubFetch(() => ({ body: EMPTY_BODY }));
  for (const bad of ['2026-3-4', '03/04/2026', '', 'yesterday', '2026-03-04T00:00:00Z']) {
    await assert.rejects(
      () => cmdDownload835(cfg(impl), { date: bad }),
      (err: unknown) =>
        err instanceof CmdEra835Error && err.code === 'invalid_date' && /ISO YYYY-MM-DD/.test(err.message),
    );
  }
  assert.equal(urls.length, 0, 'a malformed date must never reach the wire');
});

// --- 2. the empty day is NOT an error — DIGEST-ANCHORED ---------------------
// Rewritten 2026-07-31. These previously asserted that the DOCUMENTED prose classifies
// as `empty`. CMD does not send that wording — its live no-data body is worded
// differently — so the prose matcher matched nothing real and EVERY QUIET DAY counted as
// a hard failure. Classification is now by exact sha256 against KNOWN_EMPTY_DAY_DIGESTS,
// and the prose survives only as a diagnostic flag.

test('the observed production empty-day digest is allowlisted (locks the seed value)', () => {
  // Observed 2026-07-31: 44-byte body, byte-identical across FRCA 10032340 + TBH 10029105
  // over 2026-07-28..31 (8/8 calls, one digest). If this constant is ever edited, the
  // live quiet-day path breaks silently-loudly (every quiet day starts failing), so the
  // value is pinned here.
  assert.ok(
    KNOWN_EMPTY_DAY_DIGESTS.has('83b3fc6a77ef99a73263d6b1632b4e05edaf32197cc60327ef057e951728f290'),
    'the empirically observed CMD no-data digest must stay allowlisted',
  );
});

test('cmdDownload835 classifies an ALLOWLISTED digest as `empty`, not as a failure', async () => {
  // THE PATH THAT HAD NEVER BEEN EXERCISED. The production digest's preimage is
  // deliberately not stored anywhere (zero-disclosure), so the allowlist is injected.
  const body = 'CMD no-data body stand-in — any bytes; the DIGEST is what decides.';
  const { impl } = stubFetch(() => ({ status: 200, body }));
  const res = await cmdDownload835(
    cfg(impl, { knownEmptyDayDigests: new Set([bodyDigest(Buffer.from(body, 'utf8'))]) }),
    { date: '2026-03-04' },
  );
  assert.deepEqual(res, { kind: 'empty' });
});

test('bodyDigest is stable: identical bytes → identical digest, and it is a full-body hash', () => {
  const a = Buffer.from('No 835 ERA files were received on that date.', 'utf8');
  const b = Buffer.from('No 835 ERA files were received on that date.', 'utf8');
  assert.equal(bodyDigest(a), bodyDigest(b));
  assert.match(bodyDigest(a), /^[0-9a-f]{64}$/);
  // A one-byte change must change the digest (so drift cannot slip through).
  assert.notEqual(bodyDigest(a), bodyDigest(Buffer.from('No 835 ERA files were received on that date', 'utf8')));
});

test('THE ANTI-SILENT-SWALLOW GUARD: a short printable body with an UNKNOWN digest FAILS', async () => {
  // The single most important test here. A body that merely LOOKS like a quiet-day
  // message must NOT be classified empty — otherwise a genuine service error served with
  // HTTP 200 becomes "no upcoming payments today", which on a money feed reads as good
  // news. Note this uses the DOCUMENTED sentinel, which is exactly such a body: it reads
  // like a quiet day and its digest is not allowlisted.
  const { impl } = stubFetch(() => ({ status: 200, body: EMPTY_BODY }));
  await assert.rejects(
    () => cmdDownload835(cfg(impl), { date: '2026-03-04' }),
    (err: unknown) => {
      assert.ok(err instanceof CmdEra835Error);
      assert.equal(err.code, 'unrecognized_short_text');
      assert.equal(err.status, 200);
      // The digest is reported so resolving a real drift is a one-line allowlist change.
      assert.equal(err.digest, bodyDigest(Buffer.from(EMPTY_BODY, 'utf8')));
      assert.equal(err.byteLength, Buffer.byteLength(EMPTY_BODY, 'utf8'));
      // …and the prose marker is reported as a DIAGNOSTIC — it did match, and it still
      // did not make this `empty`. That separation is the whole fix.
      assert.equal(err.markerMatched, true);
      return true;
    },
  );
});

test('an error page is NOT put in the drift bucket (it must not invite allowlisting)', async () => {
  // The drift bucket implies "consider allowlisting this as empty". Service faults must
  // never land there, or that reflex promotes a 200-with-an-error to "no remittances".
  for (const [label, body, shape] of [
    ['HTML session-expired page', '<html><body>Session expired</body></html>', 'looks_like_html'],
    ['JSON error envelope', '{"error":"insufficient privileges"}', 'looks_like_json'],
    ['a zero-byte body', '', 'unknown'],
  ] as const) {
    const { impl } = stubFetch(() => ({ status: 200, body }));
    await assert.rejects(
      () => cmdDownload835(cfg(impl), { date: '2026-03-04' }),
      (err: unknown) =>
        err instanceof CmdEra835Error &&
        err.code === 'unrecognized_body' &&
        err.shape === shape &&
        err.markerMatched === false,
      `${label} must be unrecognized_body, not the drift bucket`,
    );
  }
});

// --- 3. a real payload -------------------------------------------------------

test('cmdDownload835 returns the ZIP bytes for a real payload', async () => {
  const zip = makeZip([{ name: 'era1.835', body: ISA_EDI }]);
  const { impl } = stubFetch(() => ({ body: zip }));
  const res = await cmdDownload835(cfg(impl), { date: '2026-03-04' });

  assert.equal(res.kind, 'zip');
  assert.ok(res.kind === 'zip' && res.bytes.equals(zip));
  // And it round-trips through the parser.
  const files = res.kind === 'zip' ? read835Files(res.bytes) : [];
  assert.equal(files.length, 1);
  assert.equal(files[0]!.name, 'era1.835');
  assert.ok(files[0]!.edi.startsWith('ISA'));
});

// --- 4. THE BUG: an unrecognized 200 must not look like a quiet day ---------

test('cmdDownload835 throws on an HTTP 200 whose body is neither ZIP nor the sentinel', async () => {
  // Each of these previously filtered down to [] and read as "no remittances today".
  const bodies: Array<[string, Buffer | string]> = [
    ['base64 of a zip', Buffer.from(makeZip([{ name: 'a.835', body: ISA_EDI }])).toString('base64')],
    ['an HTML error page served 200', '<html><body>Session expired</body></html>'],
    ['an empty body', ''],
    ['a JSON error envelope', '{"error":"insufficient privileges"}'],
  ];
  for (const [label, body] of bodies) {
    const { impl } = stubFetch(() => ({ status: 200, body }));
    await assert.rejects(
      () => cmdDownload835(cfg(impl), { date: '2026-03-04' }),
      (err: unknown) =>
        err instanceof CmdEra835Error &&
        (err.code === 'unrecognized_body' || err.code === 'unrecognized_short_text') &&
        err.status === 200 &&
        // Every unrecognized body reports its digest, so a real drift is one line to fix.
        /^[0-9a-f]{64}$/.test(err.digest ?? ''),
      `should have thrown for: ${label}`,
    );
  }
});

test('cmdDownload835 surfaces a non-2xx as a typed http_status error', async () => {
  for (const status of [400, 401, 403, 500, 503]) {
    const { impl } = stubFetch(() => ({ status, body: 'nope' }));
    await assert.rejects(
      () => cmdDownload835(cfg(impl), { date: '2026-03-04' }),
      (err: unknown) =>
        err instanceof CmdEra835Error &&
        err.code === 'http_status' &&
        err.status === status &&
        err.message.includes(`HTTP ${status}`),
    );
  }
});

test('cmdDownload835 wraps a network/abort failure without leaking anything', async () => {
  const impl = (async () => {
    throw new Error('connect ECONNREFUSED 10.0.0.1:443');
  }) as unknown as typeof fetch;
  await assert.rejects(
    () => cmdDownload835(cfg(impl), { date: '2026-03-04' }),
    (err: unknown) =>
      err instanceof CmdEra835Error &&
      err.code === 'request_failed' &&
      // The underlying message (which could name a host) must not survive.
      !err.message.includes('ECONNREFUSED'),
  );
});

// --- 5. PHI safety of every error path --------------------------------------

/** PHI-bearing fixture: fake names/ids, shaped like a real 835 patient segment. */
const PHI_EDI = ISA_EDI + 'NM1*QC*1*DOE*JANE****MI*MEMBER12345~';

/** Asserts a thrown transport error is safe to put in a log. Reused by every path. */
function assertPhiSafe(err: unknown): true {
  assert.ok(err instanceof CmdEra835Error, `expected CmdEra835Error, got ${String(err)}`);
  const text = `${err.name}: ${err.message} ${JSON.stringify({ code: err.code, status: err.status, shape: err.shape })}`;
  for (const leak of ['DOE', 'JANE', 'MEMBER12345', 'ISA*', 'NM1*', 'Session expired', 'insufficient privileges']) {
    assert.ok(!text.includes(leak), `error leaked ${leak}: ${text}`);
  }
  assert.ok(!text.includes('webapi.example.test'), `error leaked the URL: ${text}`);
  assert.ok(!text.includes('10025030'), `error leaked the customer id: ${text}`);
  // Credential material: neither the pair nor the encoded Basic header may appear.
  assert.ok(!text.includes('u:p'), `error leaked credentials: ${text}`);
  assert.ok(!text.includes(Buffer.from('u:p').toString('base64')), `error leaked the auth header: ${text}`);
  return true;
}

test('no thrown error carries body content, the URL, or credentials — EVERY path', async () => {
  // One case per error path the module can produce.
  const paths: Array<{ label: string; run: () => Promise<unknown> }> = [
    {
      label: 'invalid_date',
      run: () => cmdDownload835(cfg(stubFetch(() => ({ body: PHI_EDI })).impl), { date: 'nope' }),
    },
    {
      label: 'unrecognized_body / looks_like_edi',
      run: () => cmdDownload835(cfg(stubFetch(() => ({ status: 200, body: PHI_EDI })).impl), { date: '2026-03-04' }),
    },
    {
      label: 'unrecognized_body / looks_like_html',
      run: () =>
        cmdDownload835(cfg(stubFetch(() => ({ status: 200, body: '<html>Session expired</html>' })).impl), {
          date: '2026-03-04',
        }),
    },
    {
      label: 'unrecognized_body / looks_like_json',
      run: () =>
        cmdDownload835(cfg(stubFetch(() => ({ status: 200, body: '{"e":"insufficient privileges"}' })).impl), {
          date: '2026-03-04',
        }),
    },
    {
      label: 'http_status 403 (the new role message)',
      run: () => cmdDownload835(cfg(stubFetch(() => ({ status: 403, body: PHI_EDI })).impl), { date: '2026-03-04' }),
    },
    {
      label: 'http_status 500',
      run: () => cmdDownload835(cfg(stubFetch(() => ({ status: 500, body: PHI_EDI })).impl), { date: '2026-03-04' }),
    },
    {
      label: 'response_too_large (streamed)',
      run: () =>
        cmdDownload835(cfg(stubFetch(() => ({ body: Buffer.from(PHI_EDI.repeat(200)) })).impl, 256), {
          date: '2026-03-04',
        }),
    },
    {
      label: 'response_too_large (declared Content-Length)',
      run: () =>
        cmdDownload835(cfg(stubFetch(() => ({ body: PHI_EDI, contentLength: '99999999' })).impl, 256), {
          date: '2026-03-04',
        }),
    },
    {
      label: 'request_failed',
      run: () =>
        cmdDownload835(
          cfg((async () => {
            throw new Error(`connect ECONNREFUSED 10.0.0.1:443 while sending ${PHI_EDI}`);
          }) as unknown as typeof fetch),
          { date: '2026-03-04' },
        ),
    },
  ];

  for (const { label, run } of paths) {
    await assert.rejects(run, (err: unknown) => assertPhiSafe(err), `PHI leak on path: ${label}`);
  }
});

// --- 6. read835Files stays non-throwing -------------------------------------

test('read835Files returns [] (never throws) for content it cannot parse', () => {
  // Deliberate: the empty-vs-undecodable split happens at transport. Throwing here
  // would alarm on every genuinely quiet day.
  assert.deepEqual(read835Files(Buffer.from('not edi at all', 'utf8')), []);
  assert.deepEqual(read835Files(Buffer.alloc(0)), []);
});

test('read835Files skips non-ISA zip entries but keeps the real ERAs', () => {
  const zip = makeZip([
    { name: 'readme.txt', body: 'This archive contains ERA files.' },
    { name: 'era1.835', body: ISA_EDI },
    { name: 'era2.835', body: ISA_EDI },
  ]);
  const files = read835Files(zip);
  assert.deepEqual(
    files.map((f) => f.name),
    ['era1.835', 'era2.835'],
  );
});

test('read835Files reads a raw-EDI payload under the fallback name', () => {
  const files = read835Files(Buffer.from(ISA_EDI, 'utf8'), '10025030_2026-03-04');
  assert.equal(files.length, 1);
  assert.equal(files[0]!.name, '10025030_2026-03-04');
});

// --- 7. the response is bounded BEFORE it is buffered -----------------------

test('cmdDownload835 refuses a body that exceeds the cap, without buffering it', async () => {
  const cap = 256 * 1024;
  const oversized = makeZip([{ name: 'big.835', body: ISA_EDI + 'X'.repeat(cap * 2) }]);
  const { impl } = stubFetch(() => ({ body: oversized }));
  await assert.rejects(
    () => cmdDownload835(cfg(impl, cap), { date: '2026-03-04' }),
    (err: unknown) => err instanceof CmdEra835Error && err.code === 'response_too_large',
  );
});

test('cmdDownload835 terminates promptly on an ENDLESS body rather than spinning', async () => {
  const { impl } = stubFetch(() => ({ stream: endlessStream() }));
  // Without a streaming bound this never returns. With one it must fail fast.
  await assert.rejects(
    () => cmdDownload835(cfg(impl, 512 * 1024), { date: '2026-03-04' }),
    (err: unknown) => err instanceof CmdEra835Error && err.code === 'response_too_large',
  );
});

test('cmdDownload835 early-rejects an oversized declared Content-Length', async () => {
  const { impl } = stubFetch(() => ({ body: 'x', contentLength: String(999 * 1024 * 1024) }));
  await assert.rejects(
    () => cmdDownload835(cfg(impl, 1024), { date: '2026-03-04' }),
    (err: unknown) => err instanceof CmdEra835Error && err.code === 'response_too_large',
  );
});

test('cmdDownload835 does not TRUST Content-Length — the streamed count is authoritative', async () => {
  // Header lies small; the real body is over the cap. Must still be caught.
  const cap = 64 * 1024;
  const oversized = makeZip([{ name: 'big.835', body: ISA_EDI + 'X'.repeat(cap * 4) }]);
  const { impl } = stubFetch(() => ({ body: oversized, contentLength: '10' }));
  await assert.rejects(
    () => cmdDownload835(cfg(impl, cap), { date: '2026-03-04' }),
    (err: unknown) => err instanceof CmdEra835Error && err.code === 'response_too_large',
  );
});

test('cmdDownload835 still enforces the cap on the no-stream fallback path', async () => {
  const oversized = makeZip([{ name: 'big.835', body: ISA_EDI + 'X'.repeat(4096) }]);
  const { impl } = stubFetch(() => ({ body: oversized, noStream: true }));
  await assert.rejects(
    () => cmdDownload835(cfg(impl, 512), { date: '2026-03-04' }),
    (err: unknown) => err instanceof CmdEra835Error && err.code === 'response_too_large',
  );
});

test('a normal payload passes well under the shipped default cap', async () => {
  const zip = makeZip([{ name: 'era1.835', body: ISA_EDI }]);
  assert.ok(zip.length < MAX_RESPONSE_BYTES / 1000, 'a real daily ZIP is orders of magnitude under the cap');
  const { impl } = stubFetch(() => ({ body: zip }));
  const res = await cmdDownload835(cfg(impl), { date: '2026-03-04' });
  assert.equal(res.kind, 'zip');
});

// --- 8. 401/403 names the credential path, not a network fault ---------------

test('cmdDownload835: 401/403 name the credential and the Payment role explicitly', async () => {
  for (const status of [401, 403]) {
    const { impl } = stubFetch(() => ({ status, body: 'denied' }));
    await assert.rejects(
      () => cmdDownload835(cfg(impl), { date: '2026-03-04' }),
      (err: unknown) => {
        assert.ok(err instanceof CmdEra835Error);
        assert.equal(err.code, 'http_status');
        assert.equal(err.status, status);
        assert.match(err.message, /Payment role/);
        assert.match(err.message, /CMD_API_USERNAME/);
        assert.match(err.message, /NOT a network fault/);
        return true;
      },
    );
  }
});

test('cmdDownload835: other non-2xx stay generic (no misleading role claim)', async () => {
  for (const status of [400, 429, 500, 503]) {
    const { impl } = stubFetch(() => ({ status, body: 'x' }));
    await assert.rejects(
      () => cmdDownload835(cfg(impl), { date: '2026-03-04' }),
      (err: unknown) =>
        err instanceof CmdEra835Error && err.code === 'http_status' && !/Payment role/.test(err.message),
    );
  }
});

// --- 9. the derived, non-PHI shape tag --------------------------------------

test('classifyBodyShape derives the tag from leading bytes only', () => {
  assert.equal(classifyBodyShape(Buffer.from(ISA_EDI)), 'looks_like_edi');
  assert.equal(classifyBodyShape(Buffer.from('   ISA*00*...')), 'looks_like_edi');
  assert.equal(classifyBodyShape(Buffer.from('<!DOCTYPE html><html>')), 'looks_like_html');
  assert.equal(classifyBodyShape(Buffer.from('<?xml version="1.0"?>')), 'looks_like_html');
  assert.equal(classifyBodyShape(Buffer.from('{"error":"nope"}')), 'looks_like_json');
  assert.equal(classifyBodyShape(Buffer.from('[{"a":1}]')), 'looks_like_json');
  assert.equal(classifyBodyShape(Buffer.from('UEsDBAo=')), 'unknown');
  assert.equal(classifyBodyShape(Buffer.alloc(0)), 'unknown');
});

test('an unrecognized body carries its shape tag, digest and byte count on the error AND in the message', async () => {
  // Identified shapes go to 'unrecognized_body'; short printable text of UNKNOWN shape is
  // the drift bucket. Both report shape + sha256 + length, and neither reports content.
  const cases: Array<[string, string, 'unrecognized_body' | 'unrecognized_short_text']> = [
    [ISA_EDI, 'looks_like_edi', 'unrecognized_body'],
    ['<html><body>Session expired</body></html>', 'looks_like_html', 'unrecognized_body'],
    ['{"error":"insufficient privileges"}', 'looks_like_json', 'unrecognized_body'],
    ['UEsDBAoAAAAAA', 'unknown', 'unrecognized_short_text'],
  ];
  for (const [body, shape, code] of cases) {
    const { impl } = stubFetch(() => ({ status: 200, body }));
    await assert.rejects(
      () => cmdDownload835(cfg(impl), { date: '2026-03-04' }),
      (err: unknown) => {
        assert.ok(err instanceof CmdEra835Error);
        assert.equal(err.code, code);
        assert.equal(err.shape, shape);
        assert.match(err.message, new RegExp(`shape=${shape}`));
        assert.equal(err.digest, bodyDigest(Buffer.from(body, 'utf8')));
        assert.equal(err.byteLength, Buffer.byteLength(body, 'utf8'));
        assert.match(err.message, /sha256=[0-9a-f]{64}/);
        // ZERO DISCLOSURE: the body must never appear in the message.
        assert.ok(!err.message.includes(body), 'the message must not embed the body');
        return true;
      },
    );
  }
});

// --- 10. the ingest loop separates empty / zero-file / failed ----------------

const CUSTOMERS: CmdCustomer[] = [
  { customerId: '10027973', facilityCode: 'CAMH', businessEntityId: 'af504ab6-3dcd-4aa4-a93c-27bc58de4088' },
  { customerId: '10033950', facilityCode: 'DMH', businessEntityId: 'af504ab6-3dcd-4aa4-a93c-27bc58de4088' },
];

/** DRY-RUN ingest (no writeDb ⇒ no DB connection) over an injected download. */
function ingest(download: (customerId: string, date: string) => Promise<Era835DownloadResult>) {
  return runEra835Ingest({
    customers: CUSTOMERS,
    dates: ['2026-03-04', '2026-03-05'],
    ingestedBy: 'test',
    download,
  });
}

test('ingest: CMD\'s documented quiet day counts as empty, not as a failure', async () => {
  const stats = await ingest(async () => ({ kind: 'empty' }));
  assert.equal(stats.pulls_attempted, 4);
  assert.equal(stats.pulls_empty, 4);
  assert.equal(stats.pulls_zero_files, 0);
  assert.equal(stats.pulls_failed, 0);
  assert.equal(stats.rows_inserted, 0);
});

test('ingest: a real ZIP holding no ISA files counts as zero_files, NOT as empty', async () => {
  const stats = await ingest(async () => ({ kind: 'files', files: [] }));
  assert.equal(stats.pulls_zero_files, 4, 'a parsed-but-empty archive is its own signal');
  assert.equal(stats.pulls_empty, 0, 'it is NOT CMD saying there were no ERAs');
  assert.equal(stats.pulls_failed, 0, 'and it is not an error either');
});

test('ingest: an unrecognized body counts as FAILED, never as a quiet day', async () => {
  const stats = await ingest(async () => {
    throw new CmdEra835Error(
      'unrecognized_body',
      'CMD download-835: HTTP 200 with an unrecognized body (shape=looks_like_html, 42 bytes)',
      200,
      'looks_like_html',
    );
  });
  assert.equal(stats.pulls_failed, 4, 'an undecodable body must not be silently absorbed');
  assert.equal(stats.pulls_empty, 0);
  assert.equal(stats.pulls_zero_files, 0);
});

test('ingest: empty, zero-file and failed increment independently in one mixed run', async () => {
  const stats = await ingest(async (customerId, date) => {
    if (date === '2026-03-04') return { kind: 'empty' };
    if (customerId === '10027973') return { kind: 'files', files: [] };
    throw new CmdEra835Error('http_status', 'CMD download-835 failed: HTTP 403', 403);
  });
  assert.equal(stats.pulls_attempted, 4);
  assert.equal(stats.pulls_empty, 2);
  assert.equal(stats.pulls_zero_files, 1);
  assert.equal(stats.pulls_failed, 1);
});

// --- 11. per-code failure buckets + the fatal (401/403 abort) seam ------------
// Finding-1 posture: the root cause of the probe's 30%/42% failure episodes is UNKNOWN
// and the throttle theory is falsified, so the cron does NO retries — it counts failures
// by the same per-code taxonomy the probe uses, and aborts outright on a credential
// rejection. These tests pin that instrumentation.

test('ingest: failures are bucketed by CmdEra835Error code, non-typed errors under `other`', async () => {
  const stats = await ingest(async (customerId, date) => {
    if (date === '2026-03-04' && customerId === '10027973') {
      throw new CmdEra835Error('unrecognized_short_text', 'drift bucket', 200, 'unknown');
    }
    if (date === '2026-03-04') throw new CmdEra835Error('request_failed', 'network');
    if (customerId === '10027973') throw new CmdEra835Error('request_failed', 'network');
    throw new Error('something else entirely'); // not a CmdEra835Error
  });
  assert.equal(stats.pulls_failed, 4);
  assert.deepEqual(stats.pulls_failed_by_code, {
    unrecognized_short_text: 1,
    request_failed: 2,
    other: 1,
  });
});

test('ingest: fatal seam aborts the WHOLE run on a matching error and stops calling CMD', async () => {
  // A 401 credential rejection: every remaining pull would fail identically, so the run
  // must stop — not iterate 74 more times against a rejected credential.
  const calls: string[] = [];
  const authErr = new CmdEra835Error(
    'http_status',
    'CMD download-835 failed: HTTP 401 — the CMD credential was rejected or lacks the Payment role',
    401,
  );
  await assert.rejects(
    () =>
      runEra835Ingest({
        customers: CUSTOMERS,
        dates: ['2026-03-04', '2026-03-05'],
        ingestedBy: 'test',
        download: async (customerId, date) => {
          calls.push(`${customerId}:${date}`);
          if (calls.length === 2) throw authErr;
          return { kind: 'empty' };
        },
        fatal: (err) =>
          err instanceof CmdEra835Error &&
          err.code === 'http_status' &&
          (err.status === 401 || err.status === 403),
      }),
    (err: unknown) => err === authErr, // the ORIGINAL error surfaces, not a wrapper
  );
  assert.equal(calls.length, 2, 'no further CMD calls after the fatal failure');
});

test('ingest: without the fatal seam a 401 still gets per-pull isolation (back-compat)', async () => {
  const stats = await ingest(async () => {
    throw new CmdEra835Error('http_status', 'CMD download-835 failed: HTTP 401', 401);
  });
  assert.equal(stats.pulls_attempted, 4, 'default behavior unchanged: all pulls attempted');
  assert.equal(stats.pulls_failed, 4);
  assert.deepEqual(stats.pulls_failed_by_code, { http_status: 4 });
});

// --- 12. run-level observability: per-tenant attribution + status derivation ---
// Migration 022 (staging.era_835_ingest_run). WHY: the 2026-08-02 production run parsed
// 112 remits and inserted 39 — the other 73 took the ON CONFLICT DO NOTHING path and were
// recorded NOWHERE. These tests pin the counters and the status vocabulary that make a
// silent no-op queryable after the fact.

const INDIGO = '141d459c-0000-4000-8000-000000000001';
/** A two-tenant roster: 2 BXR customers + 1 Indigo. Today's live roster is BXR-only, so
 *  this is the shape that must keep working the day Indigo joins. */
const MIXED: CmdCustomer[] = [
  ...CUSTOMERS,
  { customerId: '10021230', facilityCode: '10021230', businessEntityId: INDIGO },
];

test('ingest: by_entity seeds EVERY roster tenant up front, with its customer count', async () => {
  // Seeded before the first pull, so a tenant whose every pull budget-skips (or a run that
  // dies early) still records how many customers it should have covered.
  const stats = await runEra835Ingest({
    customers: MIXED,
    dates: ['2026-03-04'],
    ingestedBy: 'test',
    download: async () => ({ kind: 'empty' }),
  });
  assert.deepEqual(Object.keys(stats.by_entity).sort(), [CUSTOMERS[0]!.businessEntityId, INDIGO].sort());
  assert.equal(stats.by_entity[CUSTOMERS[0]!.businessEntityId]!.customers_total, 2);
  assert.equal(stats.by_entity[INDIGO]!.customers_total, 1);
});

test('ingest: counters attribute to the customer\'s OWN tenant, never blended', async () => {
  const stats = await runEra835Ingest({
    customers: MIXED,
    dates: ['2026-03-04', '2026-03-05'],
    ingestedBy: 'test',
    download: async (customerId) => {
      if (customerId === '10021230') throw new CmdEra835Error('request_failed', 'network');
      return { kind: 'empty' };
    },
  });
  const bxr = stats.by_entity[CUSTOMERS[0]!.businessEntityId]!;
  const indigo = stats.by_entity[INDIGO]!;
  assert.equal(bxr.pulls_attempted, 4, '2 BXR customers x 2 dates');
  assert.equal(bxr.pulls_empty, 4);
  assert.equal(bxr.pulls_failed, 0, "Indigo's failures must not land on BXR");
  assert.equal(indigo.pulls_attempted, 2);
  assert.equal(indigo.pulls_failed, 2);
  assert.deepEqual(indigo.pulls_failed_by_code, { request_failed: 2 });
  // The run-wide counters are unchanged and still the sum — the log line keeps working.
  assert.equal(stats.pulls_attempted, 6);
  assert.equal(stats.pulls_failed, 2);
});

test('ingest: the budget-skip branch attributes to its tenant too', async () => {
  // Budget already blown, so every pull skips before any download — the branch that is
  // easiest to forget because it `continue`s before the attempt counter.
  let t = 0;
  const stats = await runEra835Ingest({
    customers: MIXED,
    dates: ['2026-03-04'],
    ingestedBy: 'test',
    download: async () => ({ kind: 'empty' }),
    budgetMs: 1,
    now: () => (t += 1_000),
  });
  assert.equal(stats.pulls_attempted, 0, 'nothing was attempted');
  assert.equal(stats.pulls_skipped_budget, 3);
  assert.equal(stats.by_entity[CUSTOMERS[0]!.businessEntityId]!.pulls_skipped_budget, 2);
  assert.equal(stats.by_entity[INDIGO]!.pulls_skipped_budget, 1);
});

test('ingest: a CALLER-OWNED stats object survives a fatal abort with REAL counters', async () => {
  // FIX for the poisoned-detector case: runEra835Ingest RETURNS its stats, so a mid-run
  // throw would otherwise discard every counter while the completed pulls' inserts are
  // already committed. A run that did work and then died must not record zeros — the next
  // 5-day re-pull would dedupe those rows and the whole sequence would read healthy.
  const stats = newEra835IngestStats();
  const authErr = new CmdEra835Error('http_status', 'HTTP 401', 401);
  await assert.rejects(() =>
    runEra835Ingest({
      stats,
      customers: CUSTOMERS,
      dates: ['2026-03-04', '2026-03-05'],
      ingestedBy: 'test',
      download: async (_c, date) => {
        if (date === '2026-03-05') throw authErr;
        return { kind: 'empty' };
      },
      fatal: (err) => err instanceof CmdEra835Error && err.status === 401,
    }),
  );
  // The two pulls that completed BEFORE the abort are still on the object the caller holds.
  assert.equal(stats.pulls_attempted, 3, 'two clean pulls + the one that threw');
  assert.equal(stats.pulls_empty, 2, 'the completed work is NOT lost');
  assert.equal(stats.by_entity[CUSTOMERS[0]!.businessEntityId]!.pulls_empty, 2);
});

test('seedEra835TenantRoster: ASSIGNS customers_total, so seeding twice is a no-op', async () => {
  // The handler seeds before the PHI probe and runEra835Ingest seeds again on entry; if
  // this incremented, every run would report double the roster size.
  const stats = newEra835IngestStats();
  seedEra835TenantRoster(stats, MIXED);
  seedEra835TenantRoster(stats, MIXED);
  assert.equal(stats.by_entity[CUSTOMERS[0]!.businessEntityId]!.customers_total, 2);
  assert.equal(stats.by_entity[INDIGO]!.customers_total, 1);
});

test('era835RunStatus: ok / partial / empty, and zero-attempts is NOT ok', () => {
  const c = (over: Partial<Era835TenantCounts> = {}): Era835TenantCounts => ({
    ...blankEra835TenantCounts(),
    ...over,
  });
  assert.equal(era835RunStatus(c({ pulls_attempted: 5, pulls_empty: 2 })), 'ok');
  assert.equal(era835RunStatus(c({ pulls_attempted: 5, pulls_failed: 1 })), 'partial');
  assert.equal(era835RunStatus(c({ pulls_attempted: 5, pulls_zero_files: 1 })), 'partial');
  assert.equal(era835RunStatus(c({ pulls_attempted: 5, pulls_skipped_budget: 1 })), 'partial');
  // THE CREDENTIAL-LOST-PAYMENT-ROLE SIGNATURE: every pull succeeds, every pull is empty.
  // Today that returns 200 {ok:true} and looks exactly like a quiet day.
  assert.equal(era835RunStatus(c({ pulls_attempted: 5, pulls_empty: 5 })), 'empty');
  // Zero attempts has proven NOTHING about the feed's health — reporting 'ok' would be
  // the same false reassurance as collapsing 'empty' into 'ok'.
  assert.equal(era835RunStatus(c()), 'empty');
  assert.equal(era835RunStatus(c({ customers_total: 3 })), 'empty');
  // 'partial' wins over 'empty' when both could apply — a failure is the louder signal.
  assert.equal(era835RunStatus(c({ pulls_attempted: 2, pulls_empty: 2, pulls_failed: 1 })), 'partial');
});

test('recordEra835IngestRun: one GUC-scoped INSERT per tenant, bound params only', async () => {
  const statements: Array<{ sql: string; params: unknown[] }> = [];
  const guc: string[] = [];
  const client = {
    query: async (sql: string, params: unknown[] = []) => {
      statements.push({ sql, params });
      if (sql.includes('set_config')) {
        guc.push(String(params[0]));
        return { rows: [] };
      }
      if (sql.includes('current_setting')) return { rows: [{ v: guc.at(-1) }] };
      if (sql.includes('current_user')) return { rows: [{ u: 'cmd_rollup_writer' }] };
      return { rows: [] };
    },
    release: () => {},
  };
  const db = { connect: async () => client } as unknown as Parameters<typeof recordEra835IngestRun>[0];

  const counts = { ...blankEra835TenantCounts(), pulls_attempted: 4, pulls_empty: 1, payments_inserted: 3 };
  await recordEra835IngestRun(
    db,
    { startedAt: '2026-08-02T08:50:00.000Z', windowStart: '2026-07-29', windowEnd: '2026-08-02' },
    { [CUSTOMERS[0]!.businessEntityId]: counts, [INDIGO]: blankEra835TenantCounts() },
  );

  const inserts = statements.filter((s) => s.sql.includes('insert into staging.era_835_ingest_run'));
  assert.equal(inserts.length, 2, 'ONE ROW PER TENANT — never skipped, never blended');
  assert.deepEqual(guc, [CUSTOMERS[0]!.businessEntityId, INDIGO], 'each row under its own tenant GUC');
  for (const ins of inserts) {
    assert.ok(!ins.sql.includes('select *'), 'explicit allowlisted columns only');
    // Every value is a bound param: no interpolated literals anywhere in the statement.
    assert.equal(ins.sql.includes("'"), false, 'no string literals spliced into the SQL');
    assert.equal(ins.params.length, 20, 'all 20 columns bound positionally');
    assert.ok(ins.sql.includes('::jsonb'), 'the failure-code map is cast, not concatenated');
  }
  // Status derives per tenant from that tenant's own counters.
  assert.equal(inserts[0]!.params[2], 'ok', '4 attempted, 1 empty, no failures');
  assert.equal(inserts[1]!.params[2], 'empty', 'the tenant that attempted nothing');
  assert.equal(inserts[0]!.params[1], 'cmd_rollup_writer', 'writer_user read inside the txn');
  assert.equal(inserts[0]!.params[19], null, 'error_detail is null on a non-failed run');
});

test('recordEra835IngestRun: a failure forces status=failed and bounds error_detail', async () => {
  const statements: Array<{ sql: string; params: unknown[] }> = [];
  const client = {
    // withTenant's read-back compares current_setting against the id it just set.
    query: async (sql: string, params: unknown[] = []) => {
      statements.push({ sql, params });
      if (sql.includes('current_setting')) return { rows: [{ v: INDIGO }] };
      if (sql.includes('current_user')) return { rows: [{ u: 'cmd_rollup_writer' }] };
      return { rows: [] };
    },
    release: () => {},
  };
  const db = { connect: async () => client } as unknown as Parameters<typeof recordEra835IngestRun>[0];

  // A failed run that HAD ALREADY INSERTED before it died: the counters must survive.
  const counts = { ...blankEra835TenantCounts(), pulls_attempted: 9, payments_inserted: 7 };
  await recordEra835IngestRun(
    db,
    { startedAt: '2026-08-02T08:50:00.000Z', windowStart: null, windowEnd: null },
    { [INDIGO]: counts },
    { error: 'x'.repeat(900) },
  );
  const ins = statements.find((s) => s.sql.includes('insert into staging.era_835_ingest_run'))!;
  assert.equal(ins.params[2], 'failed');
  assert.equal(ins.params[14], 7, 'a failed run records what it ACTUALLY inserted, not zero');
  assert.equal(ins.params[4], null, 'no window when the run died before computing one');
  assert.equal(String(ins.params[19]).length, 500, 'error_detail is bounded to the CHECK');
});
