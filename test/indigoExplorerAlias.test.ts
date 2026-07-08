/**
 * Guards the Indigo cron's one genuine failure mode: Indigo's report labels the facility column
 * "Customer Name", but the shared mapReportRows + LOCKED fingerprint read facility ONLY from
 * "Facility Name" and mapRow REQUIRES it. Without aliasIndigoFacilityColumn EVERY Indigo charge
 * line skips on facility:missing (charge_skipped == rows_fetched, cmd_explorer_rows gets 0 Indigo
 * rows). These tests pin: (1) unaliased Indigo row → skip; (2) aliased → maps; (3) BXR no-op;
 * (4) missing Customer Name → "" (skips, never crashes). ALL values are synthetic — no real PHI.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { aliasIndigoFacilityColumn, mapReportRows } from '../src/collections/cmdExplorer.js';
import { mapRow } from '../src/collections/cmdExplorerSeed.js';

/** A synthetic Indigo-shaped report row (fake PHI): facility under "Customer Name", not "Facility Name". */
const indigoRow = (): Record<string, string> => ({
  'Charge From Date': '06/01/2026',
  'Payment Received': '06/15/2026',
  'Charge CPT Code': '90837',
  'Revenue Code': '',
  'Patient Full Name': 'TEST PATIENT', //          synthetic — not real PHI
  'Claim Primary Member ID': 'TESTMEMBER1', //     synthetic
  'Primary Group Number': 'GRP1',
  'Charge/Debit Amount': '100.00',
  'Payment Allowed Amount': '80.00',
  'Charge Insurance Payments': '80.00',
  'Charge Total Adjustments w/o Transfers': '0.00',
  'Charge Balance Due Pat': '0.00',
  'Charge Primary Payer Name': 'AETNA',
  'Customer Name': 'OPUS HEALTH', //               Indigo's facility label
  'Check Payment': '0.00',
  'EFT Payment': '80.00',
  'Charge Patient Payments': '0.00',
});

test('WITHOUT the alias, an Indigo (Customer Name) row skips on facility:missing', () => {
  const full = mapReportRows([indigoRow()])[0]!;
  assert.equal(full.facility, null, 'mapReportRows finds no "Facility Name" column');
  const r = mapRow(full, 'test');
  assert.equal(r.ok, false);
  assert.equal(r.ok === false && r.label, 'facility: missing');
});

test('WITH the alias, the same row maps (facility resolved from Customer Name)', () => {
  const rows = aliasIndigoFacilityColumn([indigoRow()]);
  const full = mapReportRows(rows)[0]!;
  assert.equal(full.facility, 'OPUS HEALTH');
  const r = mapRow(full, 'test');
  assert.equal(r.ok, true);
  assert.equal(r.ok === true && r.row.facility, 'OPUS HEALTH');
});

test('aliasIndigoFacilityColumn is a no-op when "Facility Name" is already present (BXR untouched)', () => {
  const bxr: Record<string, string> = { 'Facility Name': 'CA MENTAL HEALTH', 'Customer Name': 'SHOULD NOT WIN' };
  aliasIndigoFacilityColumn([bxr]);
  assert.equal(bxr['Facility Name'], 'CA MENTAL HEALTH', 'existing Facility Name wins');
});

test('aliasIndigoFacilityColumn: missing Customer Name → "" (row skips, never crashes)', () => {
  const row: Record<string, string> = { 'Charge From Date': '06/01/2026' };
  aliasIndigoFacilityColumn([row]);
  assert.equal(row['Facility Name'], '');
});
