'use client';

/**
 * Collections surface — the CMD charge-line detail (cmd_explorer_rows): Facility/Month
 * filters, draggable column headers, patient identifiers masked by default and revealed
 * in bulk via "Reveal all" (audited). The former "Payment Type" (daily Checks/EFT/Gross)
 * view was removed; that breakdown lives on the Overview (Master chart + KPI tiles).
 *
 * `view` is the dashboard entity scope (Consolidated/BXR/Indigo) from the top-bar switcher;
 * it flows through the viewToEntityIds seam (app/lib/views.ts) — carried but not yet
 * consumed (collections data is BXR-or-stub until the data layer lands).
 */
import { type DashboardView, viewToEntityIds } from '@/lib/views';
import { CmdCollectionsExplorer } from './cmd-explorer';

export function CollectionsView({ view }: { view: DashboardView }) {
  // The view → entity-id seam (carried, not yet consumed; see app/lib/views.ts).
  const entityIds = viewToEntityIds(view);
  void entityIds;

  return <CmdCollectionsExplorer />;
}
