/**
 * Hermetic tests for the snapshot ZIP/TSV parser (src/billingAudit/snapshotParse.ts). The ZIP is
 * built in-test from hand-written local + central headers over deflate-raw payloads; every cell
 * value is synthetic.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { deflateRawSync } from 'node:zlib';
import { cmdDate, cmdMoney, cmdNumber, cmdText, cmdTimestamp, isCmdTrue, parseSnapshotZip, parseTsv } from '../src/billingAudit/snapshotParse.js';

/** Minimal ZIP writer (deflate, no data descriptors, no ZIP64) — enough for readZipEntries. */
function buildZip(entries: Array<{ name: string; data: Buffer }>): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const e of entries) {
    const comp = deflateRawSync(e.data);
    const name = Buffer.from(e.name, 'utf8');
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(8, 8); // deflate
    local.writeUInt32LE(0, 14); // crc (unchecked by the reader)
    local.writeUInt32LE(comp.length, 18);
    local.writeUInt32LE(e.data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(8, 10);
    central.writeUInt32LE(comp.length, 20);
    central.writeUInt32LE(e.data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    locals.push(local, name, comp);
    centrals.push(central, name);
    offset += local.length + name.length + comp.length;
  }
  const cd = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cd.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, eocd]);
}

test('parseTsv: header + rows, CRLF tolerant, blank lines skipped, short rows padded', () => {
  const { columns, rows } = parseTsv('A\tB\tC\r\n1\t2\t3\r\n\r\n4\t5\n\n');
  assert.deepEqual(columns, ['A', 'B', 'C']);
  assert.deepEqual(rows, [{ A: '1', B: '2', C: '3' }, { A: '4', B: '5', C: '' }]);
  assert.deepEqual(parseTsv(''), { columns: [], rows: [] });
});

test('parseTsv: values are kept verbatim (no quote or escape processing)', () => {
  const { rows } = parseTsv('M\n"quoted, text" with ""doubles""\n');
  assert.equal(rows[0]!.M, '"quoted, text" with ""doubles""');
});

test('parseSnapshotZip: .DAT entries become tables by name; meta sql is ignored', () => {
  const zip = buildZip([
    { name: '10099999/B_PAYOR.DAT', data: Buffer.from('SEQNO\tPAYOR\n1\tSYNTHETIC PAYER\n') },
    { name: '10099999/B_CHARGE.DAT', data: Buffer.from('TRANID\tAMOUNT\r\n900000001\t100.00\r\n') },
    { name: 'meta/oracle-create.sql', data: Buffer.from('CREATE TABLE B_PAYOR (SEQNO NUMBER);') },
  ]);
  const t = parseSnapshotZip(zip);
  assert.deepEqual(t.names(), ['B_CHARGE', 'B_PAYOR']);
  assert.equal(t.get('b_payor')?.rows[0]?.PAYOR, 'SYNTHETIC PAYER');
  assert.deepEqual(t.require('B_CHARGE').columns, ['TRANID', 'AMOUNT']);
  assert.equal(t.get('B_CLAIM'), null);
  assert.throws(() => t.require('B_CLAIM'), /B_CLAIM is missing/);
});

test('cmdDate / cmdTimestamp: MM/DD/YYYY forms, calendar validation, naive timestamps', () => {
  assert.equal(cmdDate('09/09/2026'), '2026-09-09');
  assert.equal(cmdDate('1/5/2026'), '2026-01-05');
  assert.equal(cmdDate('09/09/2026 14:22:01'), '2026-09-09');
  assert.equal(cmdDate('02/30/2026'), null);
  assert.equal(cmdDate('02/29/2024'), '2024-02-29');
  assert.equal(cmdDate('02/29/2026'), null);
  assert.equal(cmdDate('2026-09-09'), null);
  assert.equal(cmdDate(''), null);
  assert.equal(cmdDate(undefined), null);
  assert.equal(cmdTimestamp('09/09/2026 14:22:01'), '2026-09-09T14:22:01');
  assert.equal(cmdTimestamp('09/09/2026'), '2026-09-09T00:00:00');
  assert.equal(cmdTimestamp('09/09/2026 25:00:00'), null);
  assert.equal(cmdTimestamp('garbage'), null);
});

test('cmdNumber / cmdMoney / isCmdTrue / cmdText', () => {
  assert.equal(cmdNumber('5795'), 5795);
  assert.equal(cmdNumber(''), null);
  assert.equal(cmdNumber('abc'), null);
  assert.equal(cmdMoney('1326.02'), '1326.02');
  assert.equal(cmdMoney('-45.5'), '-45.50');
  assert.equal(cmdMoney('0'), '0.00');
  assert.equal(cmdMoney(''), null);
  assert.equal(cmdMoney('99999999999'), null);
  assert.equal(isCmdTrue('1'), true);
  assert.equal(isCmdTrue('Y'), true);
  assert.equal(isCmdTrue('0'), false);
  assert.equal(isCmdTrue('N'), false);
  assert.equal(isCmdTrue(undefined), false);
  assert.equal(cmdText('  x '), 'x');
  assert.equal(cmdText(' '), null);
});

test('parseSnapshotZip parses a table only when it is ASKED FOR, and caches it', () => {
  const zip = buildZip([
    { name: '10099999/B_CHARGE.DAT', data: Buffer.from('TRANID\tAMOUNT\n900000001\t100.00\n') },
    { name: '10099999/B_CREDIT.DAT', data: Buffer.from('SEQNO\tAMOUNT\n1\t5.00\n') },
  ]);
  const tables = parseSnapshotZip(zip);
  // names() reports every table in the snapshot whether or not anything has parsed it.
  assert.deepEqual(tables.names(), ['B_CHARGE', 'B_CREDIT']);
  const first = tables.require('B_CHARGE');
  const second = tables.require('B_CHARGE');
  assert.equal(first, second, 'a parsed table is cached — the same object, not a re-parse');
  assert.deepEqual(first.rows, [{ TRANID: '900000001', AMOUNT: '100.00' }]);
  // Still complete after a parse released that table's inflated bytes.
  assert.deepEqual(tables.names(), ['B_CHARGE', 'B_CREDIT']);
  // A never-requested table is still readable on demand (laziness is not exclusion).
  assert.deepEqual(tables.require('B_CREDIT').rows, [{ SEQNO: '1', AMOUNT: '5.00' }]);
});

test('parseSnapshotZip: a missing table throws by NAME only, after the lazy rewrite', () => {
  const zip = buildZip([{ name: '10099999/B_CHARGE.DAT', data: Buffer.from('TRANID\n1\n') }]);
  const tables = parseSnapshotZip(zip);
  assert.equal(tables.get('B_NOPE'), null);
  assert.throws(() => tables.require('b_nope'), /table B_NOPE is missing/);
});
