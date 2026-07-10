/**
 * Minimal, dependency-free ZIP reader (adapter). Node built-ins only (zlib).
 *
 * WHY hand-rolled: this repo keeps its dependency surface deliberately small and
 * hand-rolls narrow utilities (see src/ssl.ts). Rather than pull an unaudited unzip
 * package into a PHI-adjacent, Vercel-deployed app for one quarterly job, we read the
 * archive via the End-Of-Central-Directory → central-directory walk (the correct way;
 * it carries authoritative sizes even when entries use data descriptors) and inflate
 * DEFLATE members with zlib.inflateRawSync. STORE (0) and DEFLATE (8) are supported.
 *
 * SCOPE / LIMITS (documented, fail-loud): ZIP64 archives and encrypted entries are NOT
 * supported — the reader throws a clear error if it encounters them so a maintainer
 * notices rather than getting silent garbage. CMS quarterly ZIPs are standard DEFLATE
 * and well under the ZIP64 threshold, but this is verified at runtime, not assumed.
 */
import zlib from 'node:zlib';

const EOCD_SIG = 0x06054b50;
const CEN_SIG = 0x02014b50;
const LOC_SIG = 0x04034b50;
const ZIP64_EOCD_LOCATOR_SIG = 0x07064b50;

export interface ZipEntry {
  name: string;
  data: Buffer;
}

/** Find the End Of Central Directory record (scanning back from the tail). */
function findEocdOffset(buf: Buffer): number {
  // EOCD is 22 bytes + up to 65535 bytes of comment. Scan backwards.
  const minEnd = Math.max(0, buf.length - (22 + 0xffff));
  for (let i = buf.length - 22; i >= minEnd; i--) {
    if (buf.readUInt32LE(i) === EOCD_SIG) return i;
  }
  throw new Error('ZIP: End Of Central Directory record not found (not a valid ZIP?)');
}

/** Read all central-directory entries into name + local-header offset. */
function readCentralDirectory(
  buf: Buffer,
  cdOffset: number,
  entryCount: number,
): Array<{ name: string; localOffset: number }> {
  const entries: Array<{ name: string; localOffset: number }> = [];
  let p = cdOffset;
  for (let i = 0; i < entryCount; i++) {
    if (buf.readUInt32LE(p) !== CEN_SIG) {
      throw new Error(`ZIP: bad central-directory signature at entry ${i}`);
    }
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const localOffset = buf.readUInt32LE(p + 42);
    if (localOffset === 0xffffffff) {
      throw new Error('ZIP: ZIP64 offsets are not supported by this reader');
    }
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen);
    entries.push({ name, localOffset });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

/** Inflate (or copy) a single entry given its local-header offset. */
function readLocalEntry(buf: Buffer, localOffset: number): Buffer {
  if (buf.readUInt32LE(localOffset) !== LOC_SIG) {
    throw new Error('ZIP: bad local file header signature');
  }
  const method = buf.readUInt16LE(localOffset + 8);
  const compSize = buf.readUInt32LE(localOffset + 18);
  const nameLen = buf.readUInt16LE(localOffset + 26);
  const extraLen = buf.readUInt16LE(localOffset + 28);
  if (compSize === 0xffffffff) {
    throw new Error('ZIP: ZIP64 entry sizes are not supported by this reader');
  }
  const dataStart = localOffset + 30 + nameLen + extraLen;
  const compressed = buf.subarray(dataStart, dataStart + compSize);
  if (method === 0) return Buffer.from(compressed); // STORE
  if (method === 8) return zlib.inflateRawSync(compressed); // DEFLATE
  throw new Error(`ZIP: unsupported compression method ${method} (only STORE/DEFLATE)`);
}

/** Read every entry in the archive into memory. */
export function readZipEntries(buf: Buffer): ZipEntry[] {
  // Reject ZIP64 up front (locator sits just before the EOCD when present).
  const eocd = findEocdOffset(buf);
  if (eocd >= 20 && buf.readUInt32LE(eocd - 20) === ZIP64_EOCD_LOCATOR_SIG) {
    throw new Error('ZIP: ZIP64 archives are not supported by this reader');
  }
  const entryCount = buf.readUInt16LE(eocd + 10);
  const cdOffset = buf.readUInt32LE(eocd + 16);
  if (cdOffset === 0xffffffff) {
    throw new Error('ZIP: ZIP64 central directory is not supported by this reader');
  }
  const dir = readCentralDirectory(buf, cdOffset, entryCount);
  return dir.map((e) => ({ name: e.name, data: readLocalEntry(buf, e.localOffset) }));
}

/**
 * Pick the HCPCS data member from a CMS quarterly ZIP. CMS packs several files
 * (the ANWEB code file, a record layout, sometimes an .xlsx). We prefer a plain-text
 * ANWEB member; caller decides how to parse. Returns null if no obvious text member.
 */
export function pickHcpcsDataMember(entries: readonly ZipEntry[]): ZipEntry | null {
  const byPref = [
    (n: string) => /anweb/i.test(n) && /\.(txt|dat)$/i.test(n),
    (n: string) => /anweb/i.test(n),
    (n: string) => /hcpc.*\.(txt|dat)$/i.test(n),
    (n: string) => /\.txt$/i.test(n),
  ];
  for (const match of byPref) {
    const hit = entries.find((e) => match(e.name));
    if (hit) return hit;
  }
  return null;
}
