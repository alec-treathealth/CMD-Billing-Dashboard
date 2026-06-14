/**
 * Tab classification + per-shape row parsing. Columns are mapped BY HEADER NAME
 * (tolerant to the documented header drift), never by fixed position. Pure logic
 * apart from writing failures/skips to the (gitignored) report.
 */
import {
  DAILY_BLOCK_LABEL_FACILITY,
  GROUP_DETAIL_TAB_FACILITY,
  resolveFacilityValue,
} from './config.js';
import {
  normalizeDate,
  normalizeMemberId,
  normalizeMoney,
  normalizePct,
  optText,
  reconFlags,
  splitPatientName,
} from './normalize.js';
import type { FailSink } from './report.js';
import type {
  DailyRow,
  NegotiationRow,
  PaymentLineRow,
  RawRecord,
  RollupRow,
  Shape,
  TypedRecord,
  Workbook,
} from './types.js';

export interface Tab {
  title: string;
  rows: string[][]; // rows[i] = sheet row (i+1)'s cells, verbatim
}

export interface ParseResult {
  raws: RawRecord[];
  typed: TypedRecord[];
  unresolvedFacility: number; // soft: rows landed with facility_code = NULL
}

const lc = (s: string | undefined): string => (s ?? '').trim().toLowerCase();
const rowBlank = (r: string[]): boolean => r.every((c) => (c ?? '').trim() === '');

/** Find the first row index whose cells contain all signature strings (lowercased). */
function findHeaderRow(rows: string[][], signatures: string[], limit = 8): number {
  for (let i = 0; i < Math.min(rows.length, limit); i++) {
    const r = rows[i];
    if (!r) continue;
    const set = new Set(r.map(lc));
    if (signatures.every((s) => set.has(s))) return i;
  }
  return -1;
}

export function classifyShape(workbook: Workbook, tab: Tab): Shape | null {
  if (workbook.kind === 'rollup') return 'rollup';
  if (findHeaderRow(tab.rows, ['checks', 'gross']) >= 0) return 'daily';
  if (findHeaderRow(tab.rows, ['client name']) >= 0) return 'negotiation';
  if (findHeaderRow(tab.rows, ['patient full name']) >= 0) return 'payment_line';
  return null;
}

const PAYMENT_HEADER_SYNONYMS: Readonly<Record<string, keyof PaymentHeaderMap>> = {
  'charge from date': 'service_date',
  'charge primary payment date': 'payment_date',
  'charge cpt code': 'cpt_code',
  'cpt default rev code': 'revenue_code',
  'patient full name': 'patient_name',
  'claim primary member id': 'member_id',
  'primary group number': 'group_number',
  'primary group nuber': 'group_number', // observed typo (FRCA / Telehealth tabs)
  'charge/debit amount': 'charge_amount',
  'payment allowed amount': 'allowed_amount',
  'charge insurance payments': 'insurance_paid',
  'charge total adjustments w/o transfers': 'adjustment',
  'charge total adjustments': 'adjustment', // observed variant
  'charge balance due pat': 'balance_due_pt',
  'charge balance due patient': 'balance_due_pt', // observed variant
  'charge primary payer name': 'payer_name',
};
interface PaymentHeaderMap {
  service_date: number; payment_date: number; cpt_code: number; revenue_code: number;
  patient_name: number; member_id: number; group_number: number; charge_amount: number;
  allowed_amount: number; insurance_paid: number; adjustment: number; balance_due_pt: number;
  payer_name: number;
}

function detailFacility(workbook: Workbook, tabTitle: string): string | null {
  if (workbook.kind === 'single') return workbook.facilityCode ?? null;
  return GROUP_DETAIL_TAB_FACILITY[tabTitle] ?? null; // group: resolve by tab, else NULL
}

// ── Shape A: daily roll-ups (non-PHI) ──────────────────────────────────────
function parseDaily(workbook: Workbook, tab: Tab, fileId: string, report: FailSink): ParseResult {
  const out: ParseResult = { raws: [], typed: [], unresolvedFacility: 0 };
  const groupCode = workbook.kind === 'group' ? workbook.groupCode ?? null : null;
  const dateRe = /^\d{1,2}\/\d{1,2}\/\d{4}$/;

  // Daily tabs stack one or more sections vertically: a label row, a
  // Checks/EFT/Gross sub-header row, then date rows — followed by TOTALS/MTD/YTD
  // summary rows. Single workbooks have one real section; group workbooks tile
  // facilities horizontally on a section AND stack extra facilities below.
  const subRows: number[] = [];
  for (let i = 0; i < tab.rows.length; i++) {
    const r = tab.rows[i];
    if (!r) continue;
    const set = new Set(r.map(lc));
    if (set.has('checks') && set.has('gross')) subRows.push(i);
  }
  if (subRows.length === 0) return out;
  // Single workbooks: only the first section is the facility; later sections are
  // summaries (YTD etc.). Group workbooks: every section, resolved by label.
  const sectionStarts = workbook.kind === 'single' ? subRows.slice(0, 1) : subRows;

  for (const h of sectionStarts) {
    const sub = tab.rows[h];
    const labelRow = tab.rows[h - 1];
    if (!sub || !labelRow) continue;
    // Each "Checks" marks a 4-col block: date|checks|eft|gross at (c-1..c+2).
    const blocks = sub
      .map((cell, c) => (lc(cell) === 'checks' ? c : -1))
      .filter((c) => c > 0)
      .map((c) => {
        const label = (labelRow[c - 1] ?? '').trim();
        const facility = workbook.kind === 'single'
          ? workbook.facilityCode ?? null
          : DAILY_BLOCK_LABEL_FACILITY[label] ?? null;
        return { date: c - 1, checks: c, eft: c + 1, gross: c + 2, label, facility };
      })
      // Group: drop blocks whose label is not a known facility (summary sections).
      .filter((b) => b.facility !== null);
    if (blocks.length === 0) continue;

    // Data runs until the next section's label row (or end of tab).
    const myIdx = subRows.indexOf(h);
    const endExclusive = myIdx + 1 < subRows.length ? subRows[myIdx + 1]! - 1 : tab.rows.length;

    for (let i = h + 1; i < endExclusive; i++) {
      const row = tab.rows[i];
      if (!row || rowBlank(row)) continue;
      const rowNum = i + 1;
      let landedRaw = false;
      for (const b of blocks) {
        const dateCell = (row[b.date] ?? '').trim();
        if (dateCell === '') continue; // empty block on this row
        // A non-date in the date column is a footer/label/section break — skip
        // it (NOT a coercion failure; daily date columns never hold malformed dates).
        if (!dateRe.test(dateCell)) continue;
        const date = normalizeDate(dateCell);
        if (!date.ok || date.value === null) {
          report.fail({ source_file_id: fileId, source_tab: tab.title, source_row_num: rowNum, shape: 'daily', column: 'payment_date', raw_value: dateCell, reason: date.ok ? 'blank date' : date.reason });
          continue;
        }
        const checks = normalizeMoney(row[b.checks] ?? '', 'daily');
        const eft = normalizeMoney(row[b.eft] ?? '', 'daily');
        const gross = normalizeMoney(row[b.gross] ?? '', 'daily');
        const bad = [['checks_amount', checks, row[b.checks]], ['eft_amount', eft, row[b.eft]], ['gross_amount', gross, row[b.gross]]] as const;
        const moneyFail = bad.find(([, r]) => !r.ok);
        if (moneyFail) {
          const [col, r, rawv] = moneyFail;
          report.fail({ source_file_id: fileId, source_tab: tab.title, source_row_num: rowNum, shape: 'daily', column: col, raw_value: rawv ?? '', reason: (r as { reason: string }).reason });
          continue;
        }
        const drow: DailyRow = {
          facility_code: b.facility,
          source_group_code: groupCode,
          payment_date: date.value,
          checks_amount: (checks as { value: string }).value,
          eft_amount: (eft as { value: string }).value,
          gross_amount: (gross as { value: string }).value,
        };
        out.typed.push({ shape: 'daily', rowNum, row: drow });
        landedRaw = true;
      }
      if (landedRaw) {
        out.raws.push({ source_file_id: fileId, source_tab: tab.title, source_row_num: rowNum, shape: 'daily', source_group_code: groupCode, facility_code: null, raw: { cells: row } });
      }
    }
  }
  return out;
}

// ── Shape B: payment lines (PHI) ───────────────────────────────────────────
function parsePaymentLines(workbook: Workbook, tab: Tab, fileId: string, report: FailSink): ParseResult {
  const out: ParseResult = { raws: [], typed: [], unresolvedFacility: 0 };
  const h = findHeaderRow(tab.rows, ['patient full name']);
  if (h < 0) return out;
  const header = tab.rows[h];
  if (!header) return out;
  const col: Partial<PaymentHeaderMap> = {};
  header.forEach((cell, idx) => {
    const f = PAYMENT_HEADER_SYNONYMS[lc(cell)];
    if (f && col[f] === undefined) col[f] = idx;
  });
  const facility = detailFacility(workbook, tab.title);
  const groupCode = workbook.kind === 'group' ? workbook.groupCode ?? null : null;
  const cell = (row: string[], k: keyof PaymentHeaderMap): string => {
    const i = col[k];
    return i === undefined ? '' : row[i] ?? '';
  };

  for (let i = h + 1; i < tab.rows.length; i++) {
    const row = tab.rows[i];
    if (!row || rowBlank(row)) continue;
    const rowNum = i + 1;
    const fails: { column: string; raw_value: string; reason: string }[] = [];

    const coerceDate = (k: 'service_date' | 'payment_date') => {
      const raw = cell(row, k);
      if (raw.trim() === '') return null;
      const d = normalizeDate(raw);
      if (!d.ok) { fails.push({ column: k, raw_value: raw, reason: d.reason }); return null; }
      return d.value;
    };
    const money = (k: keyof PaymentHeaderMap) => {
      const raw = cell(row, k);
      const m = normalizeMoney(raw, 'phi');
      if (!m.ok) { fails.push({ column: k, raw_value: raw, reason: m.reason }); return null; }
      return m.value;
    };

    const service_date = coerceDate('service_date');
    const payment_date = coerceDate('payment_date');
    const charge_amount = money('charge_amount');
    const allowed_amount = money('allowed_amount');
    const insurance_paid = money('insurance_paid');
    const adjustment = money('adjustment');
    const balance_due_pt = money('balance_due_pt');

    if (fails.length > 0) {
      for (const f of fails) report.fail({ source_file_id: fileId, source_tab: tab.title, source_row_num: rowNum, shape: 'payment_line', ...f });
      continue;
    }
    const pname = cell(row, 'patient_name').trim();
    const split = pname === '' ? { last: '', first: '' } : splitPatientName(pname);
    const member = normalizeMemberId(cell(row, 'member_id'));
    const flags = reconFlags(charge_amount, allowed_amount, insurance_paid, adjustment);
    if (facility === null) out.unresolvedFacility += 1;

    const prow: PaymentLineRow = {
      facility_code: facility,
      source_group_code: groupCode,
      service_date, payment_date,
      cpt_code: optText(cell(row, 'cpt_code')),
      revenue_code: optText(cell(row, 'revenue_code')),
      patient_name: pname === '' ? null : pname,
      patient_last: pname === '' ? null : split.last,
      patient_first: pname === '' ? null : split.first,
      member_id_raw: member.raw,
      member_id_norm: member.norm,
      group_number: optText(cell(row, 'group_number')),
      charge_amount, allowed_amount, insurance_paid, adjustment, balance_due_pt,
      payer_name: optText(cell(row, 'payer_name')),
      recon_ok: flags.recon_ok,
      paid_gt_allowed: flags.paid_gt_allowed,
    };
    out.typed.push({ shape: 'payment_line', rowNum, row: prow });
    out.raws.push({ source_file_id: fileId, source_tab: tab.title, source_row_num: rowNum, shape: 'payment_line', source_group_code: groupCode, facility_code: facility, raw: headerObject(header, row) });
  }
  return out;
}

// ── Shape D: negotiation worklist (PHI: client_name) ───────────────────────
function parseNegotiation(workbook: Workbook, tab: Tab, fileId: string, report: FailSink): ParseResult {
  const out: ParseResult = { raws: [], typed: [], unresolvedFacility: 0 };
  const h = findHeaderRow(tab.rows, ['client name']);
  if (h < 0) return out;
  const header = tab.rows[h];
  if (!header) return out;
  const idx = (name: string) => header.findIndex((c) => lc(c) === name);
  const ci = {
    client: idx('client name'), insurance: idx('insurance'), alpha: idx('alpha'),
    homeplan: idx('homeplan'), billed: idx('billed amount'), allowed: idx('allowed amount'),
    pct: idx('percentage'), tpp: idx('tpp'), facility: idx('facility'),
  };
  const groupCode = workbook.kind === 'group' ? workbook.groupCode ?? null : null;
  const at = (row: string[], i: number) => (i < 0 ? '' : row[i] ?? '');

  for (let i = h + 1; i < tab.rows.length; i++) {
    const row = tab.rows[i];
    if (!row || rowBlank(row)) continue;
    const rowNum = i + 1;
    const fails: { column: string; raw_value: string; reason: string }[] = [];
    const money = (label: string, raw: string) => {
      const m = normalizeMoney(raw, 'phi');
      if (!m.ok) { fails.push({ column: label, raw_value: raw, reason: m.reason }); return null; }
      return m.value;
    };
    const billed_amount = money('billed_amount', at(row, ci.billed));
    const allowed_amount = money('allowed_amount', at(row, ci.allowed));
    const pctRaw = at(row, ci.pct);
    const pct = normalizePct(pctRaw);
    if (!pct.ok) fails.push({ column: 'negotiated_pct', raw_value: pctRaw, reason: pct.reason });
    if (fails.length > 0) {
      for (const f of fails) report.fail({ source_file_id: fileId, source_tab: tab.title, source_row_num: rowNum, shape: 'negotiation', ...f });
      continue;
    }
    // Facility: own column when present, else the single workbook's facility.
    let facility: string | null;
    if (ci.facility >= 0) facility = resolveFacilityValue(at(row, ci.facility));
    else facility = workbook.kind === 'single' ? workbook.facilityCode ?? null : null;
    if (facility === null) out.unresolvedFacility += 1;

    const nrow: NegotiationRow = {
      facility_code: facility,
      source_group_code: groupCode,
      client_name: optText(at(row, ci.client)), // verbatim, NOT split
      insurance: optText(at(row, ci.insurance)),
      alpha_prefix: optText(at(row, ci.alpha)),
      homeplan_state: optText(at(row, ci.homeplan)),
      billed_amount, allowed_amount,
      negotiated_pct: (pct as { value: string | null }).value,
      tpp: optText(at(row, ci.tpp)),
    };
    out.typed.push({ shape: 'negotiation', rowNum, row: nrow });
    out.raws.push({ source_file_id: fileId, source_tab: tab.title, source_row_num: rowNum, shape: 'negotiation', source_group_code: groupCode, facility_code: facility, raw: headerObject(header, row) });
  }
  return out;
}

// ── Shape C: rollups (verbatim) ────────────────────────────────────────────
function parseRollup(workbook: Workbook, tab: Tab, fileId: string): ParseResult {
  const out: ParseResult = { raws: [], typed: [], unresolvedFacility: 0 };
  let h = 0;
  while (h < tab.rows.length) { const r = tab.rows[h]; if (r && !rowBlank(r)) break; h++; }
  if (h >= tab.rows.length) return out;
  const header = tab.rows[h];
  if (!header) return out;
  const grain = tab.title.trim().toLowerCase() === 'all facility data' || lc(header[0]) === 'facility' ? 'facility' : 'payer';
  for (let i = h + 1; i < tab.rows.length; i++) {
    const row = tab.rows[i];
    if (!row || rowBlank(row)) continue;
    const rowNum = i + 1;
    const raw = headerObject(header, row);
    const rrow: RollupRow = { source_file_id: fileId, grain, raw };
    out.typed.push({ shape: 'rollup', rowNum, row: rrow });
    out.raws.push({ source_file_id: fileId, source_tab: tab.title, source_row_num: rowNum, shape: 'rollup', source_group_code: null, facility_code: null, raw });
  }
  return out;
}

function headerObject(header: string[], row: string[]): Record<string, unknown> {
  const o: Record<string, unknown> = {};
  header.forEach((hname, i) => {
    const key = (hname ?? '').trim();
    if (key !== '') o[key] = row[i] ?? '';
  });
  return o;
}

export function parseTab(workbook: Workbook, tab: Tab, fileId: string, shape: Shape, report: FailSink): ParseResult {
  switch (shape) {
    case 'daily': return parseDaily(workbook, tab, fileId, report);
    case 'payment_line': return parsePaymentLines(workbook, tab, fileId, report);
    case 'negotiation': return parseNegotiation(workbook, tab, fileId, report);
    case 'rollup': return parseRollup(workbook, tab, fileId);
  }
}
