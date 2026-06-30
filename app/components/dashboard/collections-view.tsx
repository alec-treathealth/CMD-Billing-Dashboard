'use client';

/**
 * Unified Collections surface — one tab, two views selected by a dropdown:
 *   • "Payment Type"   — the daily Checks / EFT / Gross by facility (daily_collections).
 *   • "All Collections" — the CMD charge-line detail (cmd_explorer_rows), patient
 *                         identifiers masked + revealed per row (audited).
 * Each view owns its own filter bar (Month/Year/Facility) and table; switching the
 * dropdown swaps which one renders. Aggregate/non-PHI by default; the All Collections
 * reveal path is the existing audited per-row gate.
 *
 * `view` is the dashboard entity scope (Consolidated/BXR/Indigo) from the top-bar
 * switcher; it flows through the viewToEntityIds seam (app/lib/views.ts). Carried but
 * not yet consumed — collections data is BXR-or-stub until the data layer lands.
 */
import { useState } from 'react';

import { ControlSelect } from '@/components/data-grid';
import { type DashboardView, viewToEntityIds } from '@/lib/views';
import { CollectionsExplorer } from './collections';
import { CmdCollectionsExplorer } from './cmd-explorer';

type CollectionsViewMode = 'payment_type' | 'all_collections';

export function CollectionsView({ view }: { view: DashboardView }) {
  // The view → entity-id seam (carried, not yet consumed; see app/lib/views.ts).
  const entityIds = viewToEntityIds(view);
  void entityIds;

  const [mode, setMode] = useState<CollectionsViewMode>('payment_type');

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <ControlSelect
          label="View"
          value={mode}
          ariaLabel="Collections view"
          onChange={(v) => setMode(v as CollectionsViewMode)}
        >
          <option value="payment_type">Payment Type</option>
          <option value="all_collections">All Collections</option>
        </ControlSelect>
        <p className="text-sm text-muted-foreground">
          {mode === 'payment_type'
            ? 'Daily Checks / EFT / Gross by facility.'
            : 'Charge-line detail — patient identifiers masked, revealed per row (audited).'}
        </p>
      </div>

      {mode === 'payment_type' ? <CollectionsExplorer /> : <CmdCollectionsExplorer />}
    </div>
  );
}
