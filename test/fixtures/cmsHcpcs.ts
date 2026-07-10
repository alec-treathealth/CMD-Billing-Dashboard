/**
 * Test fixtures + builders for the CMS HCPCS sync.
 *
 * Not a *.test.ts file, so the node test runner does not execute it — but it IS in the
 * tsconfig `test/**` include, so it is typechecked. Lines are built FROM the same
 * HCPCS_RECORD_LAYOUT the parser reads, which is deliberate: the parser test proves the
 * parser is consistent with its declared layout, while AUDIT.md flags that the layout
 * offsets themselves must be verified against the CMS record-layout PDF.
 */
import { HCPCS_RECORD_LAYOUT, type FixedWidthField } from '../../src/jobs/cmsHcpcsSync/layout.js';

export interface FixtureFields {
  code: string;
  longDesc: string;
  shortDesc: string;
  effective?: string; // YYYYMMDD
}

function place(buf: string[], field: FixedWidthField, value: string): void {
  for (let i = 0; i < value.length && field.start - 1 + i < field.end; i++) {
    buf[field.start - 1 + i] = value[i] as string;
  }
}

/** Build one fixed-width HCPCS line per HCPCS_RECORD_LAYOUT. */
export function buildFixedWidthLine(f: FixtureFields): string {
  const layout = HCPCS_RECORD_LAYOUT;
  const width = Math.max(
    layout.code.end,
    layout.longDesc.end,
    layout.shortDesc.end,
    layout.effectiveDate?.end ?? 0,
  );
  const buf: string[] = new Array<string>(width).fill(' ');
  place(buf, layout.code, f.code);
  place(buf, layout.longDesc, f.longDesc);
  place(buf, layout.shortDesc, f.shortDesc);
  if (f.effective && layout.effectiveDate) place(buf, layout.effectiveDate, f.effective);
  return buf.join('');
}

/** Build a multi-line fixed-width file (with a junk header line to prove skipping). */
export function buildFixedWidthFile(rows: FixtureFields[], withHeader = true): string {
  const lines: string[] = [];
  if (withHeader) lines.push('HCPCS QUARTERLY FILE HEADER — not a data row');
  for (const r of rows) lines.push(buildFixedWidthLine(r));
  return lines.join('\r\n') + '\r\n';
}

// --- minimal STORED (method 0) ZIP builder, to exercise zip.ts's directory walk ----

function u16(n: number): Buffer {
  const b = Buffer.alloc(2);
  b.writeUInt16LE(n);
  return b;
}
function u32(n: number): Buffer {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(n);
  return b;
}

export interface ZipInput {
  name: string;
  data: Buffer;
}

/** Construct a valid single-/multi-entry STORED zip (no compression, no data descriptor). */
export function buildStoredZip(entries: ZipInput[]): Buffer {
  const localChunks: Buffer[] = [];
  const central: Array<{ name: Buffer; size: number; offset: number }> = [];
  let offset = 0;

  for (const e of entries) {
    const name = Buffer.from(e.name, 'utf8');
    const local = Buffer.concat([
      u32(0x04034b50), u16(20), u16(0), u16(0), u16(0), u16(0),
      u32(0), // crc32 (reader ignores)
      u32(e.data.length), u32(e.data.length),
      u16(name.length), u16(0),
      name, e.data,
    ]);
    central.push({ name, size: e.data.length, offset });
    localChunks.push(local);
    offset += local.length;
  }

  const cdOffset = offset;
  const cdChunks: Buffer[] = [];
  for (const c of central) {
    cdChunks.push(
      Buffer.concat([
        u32(0x02014b50), u16(20), u16(20), u16(0), u16(0), u16(0), u16(0),
        u32(0), u32(c.size), u32(c.size),
        u16(c.name.length), u16(0), u16(0), u16(0), u16(0),
        u32(0), u32(c.offset),
        c.name,
      ]),
    );
  }
  const cd = Buffer.concat(cdChunks);
  const eocd = Buffer.concat([
    u32(0x06054b50), u16(0), u16(0),
    u16(entries.length), u16(entries.length),
    u32(cd.length), u32(cdOffset), u16(0),
  ]);

  return Buffer.concat([...localChunks, cd, eocd]);
}
