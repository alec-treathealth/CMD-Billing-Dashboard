/**
 * THROWAWAY fixture generator — derives a PHI-free fixture from a real Kipu
 * Billing Report export. NOT committed to the repo (scratchpad only).
 *
 * Scrubs: Full Name (patients), Provider / Signed By (staff), authorization
 * numbers, Session/Evaluation/Template ids. Shifts EVERY MM/DD/YYYY date by
 * -364 days (52 weeks — weekday-preserving, so week bucketing is unchanged).
 * Preserves: BOM, the 3-space 'Insurance 1   Insurance Company' header,
 * embedded newlines inside quoted Authorizations cells, telehealth
 * attestations, statuses, durations, times of day, roster counts.
 *
 * PHI discipline: prints ONLY aggregate counts and verification results.
 * Never prints a name, an auth number, or any row content.
 *
 *   node make-kipu-fixture.mjs <exportDir> <outDir>
 */
import { readFileSync, writeFileSync, readdirSync, mkdirSync } from 'node:fs';
import { join, basename } from 'node:path';

const [srcDir, outDir] = process.argv.slice(2);
if (!srcDir || !outDir) { console.error('usage: node make-kipu-fixture.mjs <exportDir> <outDir>'); process.exit(1); }
mkdirSync(outDir, { recursive: true });

const SHIFT_DAYS = -364;

/* ---- RFC4180 parse that KEEPS the raw header row ---- */
function parseCsvRaw(text) {
  const hadBom = text.charCodeAt(0) === 0xfeff;
  if (hadBom) text = text.slice(1);
  const rows = []; let row = [], field = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (q) {
      if (ch === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else q = false; }
      else field += ch;
    } else if (ch === '"') q = true;
    else if (ch === ',') { row.push(field); field = ''; }
    else if (ch === '\r') { /* skip */ }
    else if (ch === '\n') { row.push(field); field = ''; rows.push(row); row = []; }
    else field += ch;
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  return { hadBom, rows };
}
const serializeField = (v) => (/[",\r\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v);
const serialize = (rows) => rows.map((r) => r.map(serializeField).join(',')).join('\n') + '\n';

/* ---- date shifting: every MM/DD/YYYY token, anywhere in a field ---- */
function shiftDateToken(mm, dd, yyyy) {
  const t = new Date(Date.UTC(+yyyy, +mm - 1, +dd));
  t.setUTCDate(t.getUTCDate() + SHIFT_DAYS);
  const p = (n) => String(n).padStart(2, '0');
  return `${p(t.getUTCMonth() + 1)}/${p(t.getUTCDate())}/${t.getUTCFullYear()}`;
}
const shiftDates = (s) => s.replace(/\b(\d{1,2})\/(\d{1,2})\/(\d{4})\b/g, (_, m, d, y) => shiftDateToken(m, d, y));

/* ---- deterministic pseudonym maps ---- */
const mkMap = (prefix) => {
  const m = new Map();
  return (v) => {
    const k = String(v).trim();
    if (!k) return v;
    if (!m.has(k)) m.set(k, `${prefix} ${String(m.size + 1).padStart(2, '0')}`);
    return m.get(k);
  };
};
const mkIdMap = (prefix, start) => {
  const m = new Map();
  return (v) => {
    const k = String(v).trim();
    if (!k) return v;
    if (!m.has(k)) m.set(k, `${prefix}${start + m.size}`);
    return m.get(k);
  };
};
const patient = mkMap('Fixture Patient');
const provider = mkMap('Provider');
const sessionId = mkIdMap('', 91000);
const evalId = mkIdMap('', 92000);
const templateId = mkIdMap('', 93000);
const authNo = mkIdMap('AUTH-', 5001);

const scrubAuthCell = (cell) =>
  cell
    .split(/\r?\n/)
    .map((line) => {
      const m = line.match(/^(.*?),(\s*Start:[\s\S]*)$/);
      if (!m) return line;
      const no = m[1].trim();
      const scrubbed = /^no auth required$/i.test(no) ? no : authNo(no);
      return scrubbed + ',' + m[2];
    })
    .join('\n');

const originalNames = new Set();
const files = readdirSync(srcDir).filter((f) => f.endsWith('.csv'));
const outputs = [];

for (const f of files) {
  const { hadBom, rows } = parseCsvRaw(readFileSync(join(srcDir, f), 'utf8'));
  if (!rows.length) continue;
  const header = rows[0]; // RAW — preserves the 3-space label exactly
  const col = new Map(header.map((h, i) => [h.trim().replace(/\s+/g, ' '), i]));
  const data = rows.slice(1).filter((r) => r.some((v) => String(v).trim() !== ''));

  for (const r of data) {
    // First pass: collect original names for the leak check before scrubbing.
    const iName = col.get('Full Name');
    if (iName != null && r[iName]) originalNames.add(r[iName].trim());
  }
  for (const r of data) {
    for (const [label, i] of col) {
      if (r[i] == null) continue;
      let v = String(r[i]);
      if (label === 'Full Name') v = patient(v);
      else if (label === 'Provider' || label === 'Signed By') v = v.trim() ? provider(v) : v;
      else if (label === 'Authorizations') v = scrubAuthCell(v);
      else if (label === 'Session Id') v = sessionId(v);
      else if (label === 'Evaluation Id') v = evalId(v);
      else if (label === 'Template Id') v = templateId(v);
      v = shiftDates(v);
      r[i] = v;
    }
  }

  const kindMatch = f.match(/-([A-Za-z]+)\.csv$/);
  const kind = kindMatch ? kindMatch[1] : 'Unknown';
  const outName = `fixture-billing-Billable-${kind}.csv`;
  const text = (hadBom ? '﻿' : '') + serialize([header, ...data]);
  writeFileSync(join(outDir, outName), text, 'utf8');
  outputs.push({ outName, rows: data.length });
  console.log(`${basename(f)} -> ${outName}: ${data.length} data row(s)`);
}

/* ---- leak check: no original patient-name token may survive anywhere ---- */
const fixtureText = outputs.map((o) => readFileSync(join(outDir, o.outName), 'utf8')).join('\n');
let leaks = 0, tokensChecked = 0;
for (const name of originalNames) {
  for (const tok of name.split(/\s+/).filter((t) => t.length > 2)) {
    tokensChecked++;
    const re = new RegExp(`\\b${tok.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i');
    if (re.test(fixtureText)) leaks++;
  }
}
console.log(`patients pseudonymized: ${originalNames.size}`);
console.log(`name tokens checked: ${tokensChecked}, leaked: ${leaks}`);
console.log(`header preserved (3-space check): ${/Insurance 1 {3}Insurance Company/.test(fixtureText) ? 'YES' : 'NO'}`);
console.log(`BOM present on all: ${outputs.every((o) => readFileSync(join(outDir, o.outName), 'utf8').charCodeAt(0) === 0xfeff) ? 'YES' : 'NO'}`);
if (leaks > 0) { console.error('LEAK DETECTED — fixture is NOT safe to commit'); process.exit(1); }
