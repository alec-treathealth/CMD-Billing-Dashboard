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
 *   2) the documented empty-day 200 is classified as `empty`, NOT as an error,
 *   3) an HTTP 200 whose body is neither a ZIP nor that sentinel THROWS instead of
 *      masquerading as a quiet day (the actual bug),
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
  MAX_RESPONSE_BYTES,
  classifyBodyShape,
  cmdDownload835,
  read835Files,
  type CmdEra835Config,
} from '../src/collections/cmd835.js';
import { runEra835Ingest, type Era835DownloadResult } from '../src/ingest/era_ingest.js';
import type { CmdCustomer } from '../src/collections/cmdCustomers.js';

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

function cfg(fetchImpl: typeof fetch, maxBytes?: number): CmdEra835Config {
  return {
    baseUrl: 'https://webapi.example.test',
    customerId: '10025030',
    auth: { kind: 'basic', username: 'u', password: 'p' },
    fetchImpl,
    ...(maxBytes === undefined ? {} : { maxBytes }),
  };
}

// --- 1. the wire contract ----------------------------------------------------

test('cmdDownload835 sends exactly one `date` param — never startDate/endDate', async () => {
  const { urls, impl } = stubFetch(() => ({ body: EMPTY_BODY }));
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

// --- 2. the empty day is NOT an error ---------------------------------------

test('cmdDownload835 classifies the documented empty-day 200 as `empty`', async () => {
  const { impl } = stubFetch(() => ({ status: 200, body: EMPTY_BODY }));
  assert.deepEqual(await cmdDownload835(cfg(impl), { date: '2026-03-04' }), { kind: 'empty' });
});

test('cmdDownload835 tolerates casing/whitespace drift in the empty-day sentinel', async () => {
  for (const body of [
    'no 835 era files were received on that date.',
    '  No 835 ERA files were received on that date.  ',
    'No 835 ERA files were received\n on that date.',
    'NO 835 ERA FILES WERE RECEIVED ON THAT DATE',
  ]) {
    const { impl } = stubFetch(() => ({ body }));
    assert.deepEqual(
      await cmdDownload835(cfg(impl), { date: '2026-03-04' }),
      { kind: 'empty' },
      `should read as empty: ${JSON.stringify(body)}`,
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
        err instanceof CmdEra835Error && err.code === 'unrecognized_body' && err.status === 200,
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

test('an unrecognized body carries its shape tag on the error AND in the message', async () => {
  const cases: Array<[string, string]> = [
    [ISA_EDI, 'looks_like_edi'],
    ['<html><body>Session expired</body></html>', 'looks_like_html'],
    ['{"error":"insufficient privileges"}', 'looks_like_json'],
    ['UEsDBAoAAAAAA', 'unknown'],
  ];
  for (const [body, shape] of cases) {
    const { impl } = stubFetch(() => ({ status: 200, body }));
    await assert.rejects(
      () => cmdDownload835(cfg(impl), { date: '2026-03-04' }),
      (err: unknown) => {
        assert.ok(err instanceof CmdEra835Error);
        assert.equal(err.code, 'unrecognized_body');
        assert.equal(err.shape, shape);
        assert.match(err.message, new RegExp(`shape=${shape}`));
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
