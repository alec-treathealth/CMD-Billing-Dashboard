/**
 * Billing Audit — billing-code-decision sync ("JT Master Issues" → claims.
 * billing_code_decision). Transport-agnostic: the composition root injects the tab
 * fetcher (Google Sheets, OAuth installed-app refresh token via env — org policy
 * forbids service-account keys), the claims_audit_writer pool, and the tenant.
 *
 * LOCKED SEMANTICS (Alec, 2026-07-13):
 *  - EH canonical; JT contributes ONLY col-O stops (decisionSheet.ts); EH wins every
 *    conflict; per-tab contribution counts in the output.
 *  - The sheet remains the EDITING surface; this sync is read-only on the sheet and
 *    the app never writes back.
 *  - HASH NO-OP: sha-256 over both fetched grids; when every existing row already
 *    carries this hash, the run is a no-op (nothing changed).
 *  - DISAPPEARANCE = STOPPED, NEVER DELETED: rows the current parse didn't touch
 *    (stale sheet_sync_hash) that are still active get stopped_on = today. A row that
 *    REAPPEARS later is upserted with stopped_on from the parse (usually null) — it
 *    deliberately reactivates.
 *  - FAIL-SOFT: a fetch/parse failure of either tab keeps last good data — status
 *    'parse_failed', zero writes, notes carried; the route maps it to a non-ok field,
 *    never a crash loop.
 *  - Alias attribution is SURFACED, not resolved: carrier texts with no
 *    claims.payer_alias row are listed as unmatched (needs-ruling aliases STAY
 *    unmatched); catch-all-looking carriers ("All other …") are listed separately so
 *    their broad reach is visible every run.
 */
import { createHash } from 'node:crypto';
import { withTenant } from '../veris/withTenant.js';
import type { Db } from '../collections/db.js';
import { mergeStops, parseEhTab, parseJtStops } from './decisionSheet.js';

export const EH_TAB = 'Billing Codes - EH';
export const JT_TAB = 'Test Claim Status- JT';

export interface SheetGrid {
  rows: { rowNum: number; cells: string[] }[];
}

export interface DecisionSyncDeps {
  /** Fetch one tab's full grid (structured cells, 1-based rowNum). */
  fetchTab: (tab: string) => Promise<SheetGrid>;
  /** claims_audit_writer pool (SELECT/INSERT/UPDATE on billing_code_decision only). */
  writeDb: Db;
  businessEntityId: string;
  /** Stamp for disappearance-stops (injectable for tests). Default: today UTC. */
  todayIso?: string;
}

/** Non-PHI sync summary (matrix text is non-PHI billing configuration). */
export interface DecisionSyncStats {
  status: 'ok' | 'noop' | 'parse_failed';
  sheet_hash: string | null;
  eh_rows_parsed: number;
  jt_stops_parsed: number;
  jt_stops_applied: number;
  jt_stops_unmatched: number;
  upserted: number;
  disappeared_marked_stopped: number;
  parse_notes: string[];
  /** Distinct carrier texts with NO claims.payer_alias row — needs-ruling, unmatched. */
  unmatched_carriers: string[];
  /** Catch-all-looking carriers ("All other …") — broad-reach attribution, every run. */
  catchall_carriers: string[];
}

const UPSERT_COLS = [
  'business_entity_id', 'facility_code', 'carrier_text', 'alpha_prefix', 'loc',
  'hcpcs', 'rev_code', 'rules_text', 'dos_bundle_min', 'dos_bundle_max',
  'tob_pattern', 'drg', 'finalized_on', 'stopped_on', 'stopped_code',
  'source_tab', 'source_row', 'sheet_sync_hash',
] as const;

/** The expression list of billing_code_decision_identity_uq (0049) — must match EXACTLY. */
const CONFLICT_TARGET =
  "(business_entity_id, facility_code, carrier_text, coalesce(alpha_prefix, ''), " +
  "coalesce(loc, ''), coalesce(hcpcs, ''), coalesce(rev_code, ''))";

export async function decisionSync(deps: DecisionSyncDeps): Promise<DecisionSyncStats> {
  const stats: DecisionSyncStats = {
    status: 'ok', sheet_hash: null,
    eh_rows_parsed: 0, jt_stops_parsed: 0, jt_stops_applied: 0, jt_stops_unmatched: 0,
    upserted: 0, disappeared_marked_stopped: 0,
    parse_notes: [], unmatched_carriers: [], catchall_carriers: [],
  };

  // FAIL-SOFT boundary: fetch + parse. Any throw here → keep last good data, no writes.
  let merged: ReturnType<typeof mergeStops>['merged'];
  try {
    const [ehGrid, jtGrid] = await Promise.all([deps.fetchTab(EH_TAB), deps.fetchTab(JT_TAB)]);
    stats.sheet_hash = createHash('sha256')
      .update(JSON.stringify([ehGrid.rows, jtGrid.rows]), 'utf8')
      .digest('hex');
    const eh = parseEhTab(ehGrid, EH_TAB);
    const jt = parseJtStops(jtGrid, JT_TAB);
    const m = mergeStops(eh.decisions, jt.stops);
    merged = m.merged;
    stats.eh_rows_parsed = eh.decisions.length;
    stats.jt_stops_parsed = jt.stops.length;
    stats.jt_stops_applied = m.jt_stops_applied;
    stats.jt_stops_unmatched = m.jt_stops_unmatched;
    stats.parse_notes = [...eh.notes, ...jt.notes, ...m.notes];
    if (eh.decisions.length === 0) {
      // A whole-tab parse wipeout must never cascade into "mark everything stopped".
      throw new Error('EH tab parsed to zero decisions — refusing to sync');
    }
  } catch (err) {
    stats.status = 'parse_failed';
    stats.parse_notes.push(err instanceof Error ? err.message : String(err));
    console.error('billing-code-decisions sync: parse failed — keeping last good data:', stats.parse_notes.at(-1));
    return stats;
  }

  const hash = stats.sheet_hash!;
  return withTenant(deps.writeDb, deps.businessEntityId, async (client) => {
    // No-op check: every existing row already carries this hash → sheet unchanged.
    const check = await client.query<{ same: string; total: string }>(
      `select count(*) filter (where sheet_sync_hash = $2) as same, count(*) as total
         from claims.billing_code_decision where business_entity_id = $1`,
      [deps.businessEntityId, hash],
    );
    const same = Number(check.rows[0]?.same ?? 0);
    const total = Number(check.rows[0]?.total ?? 0);
    if (total > 0 && same === total) {
      stats.status = 'noop';
      return stats;
    }

    // Upsert every parsed row (≤ ~60 rows — one statement).
    const params: unknown[] = [];
    const tuples = merged.map((d) => {
      const vals = [
        deps.businessEntityId, d.facility_code, d.carrier_text, d.alpha_prefix, d.loc,
        d.hcpcs, d.rev_code, d.rules_text, d.dos_bundle_min, d.dos_bundle_max,
        d.tob_pattern, d.drg, d.finalized_on, d.stopped_on, d.stopped_code,
        d.source_tab, d.source_row, hash,
      ];
      const base = params.length;
      params.push(...vals);
      return `(${vals.map((_, i) => `$${base + i + 1}`).join(', ')})`;
    });
    const updates = [
      'rules_text', 'dos_bundle_min', 'dos_bundle_max', 'tob_pattern', 'drg',
      'finalized_on', 'stopped_on', 'stopped_code', 'source_tab', 'source_row', 'sheet_sync_hash',
    ].map((c) => `${c} = excluded.${c}`).join(', ');
    const res = await client.query(
      `insert into claims.billing_code_decision (${UPSERT_COLS.join(', ')}) ` +
        `values ${tuples.join(', ')} ` +
        `on conflict ${CONFLICT_TARGET} do update set ${updates}, synced_at = now()`,
      params,
    );
    stats.upserted = res.rowCount ?? 0;

    // Disappearance = stopped, never deleted. Rows this run didn't touch (stale hash)
    // that are still active stop TODAY; hash is stamped so the no-op check converges.
    const today = deps.todayIso ?? new Date().toISOString().slice(0, 10);
    const gone = await client.query(
      `update claims.billing_code_decision
          set stopped_on = $3, sheet_sync_hash = $2, synced_at = now()
        where business_entity_id = $1 and sheet_sync_hash <> $2 and stopped_on is null`,
      [deps.businessEntityId, hash, today],
    );
    stats.disappeared_marked_stopped = gone.rowCount ?? 0;
    if (stats.disappeared_marked_stopped > 0) {
      stats.parse_notes.push(
        `${stats.disappeared_marked_stopped} decision row(s) disappeared from the sheet — marked stopped ${today} (never deleted)`,
      );
    }

    // Alias attribution (surfaced, not resolved): unmatched + catch-all carriers.
    const aliasRes = await client.query<{ alias_text: string }>(
      `select alias_text from claims.payer_alias where business_entity_id = $1`,
      [deps.businessEntityId],
    );
    const aliases = new Set(aliasRes.rows.map((r) => r.alias_text.trim().toUpperCase()));
    const carriers = [...new Set(merged.map((d) => d.carrier_text))];
    stats.unmatched_carriers = carriers.filter((c) => !aliases.has(c.trim().toUpperCase())).sort();
    stats.catchall_carriers = carriers.filter((c) => /\bALL OTHER/i.test(c)).sort();
    return stats;
  });
}
