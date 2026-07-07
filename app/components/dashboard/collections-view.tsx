'use client';

/**
 * Collections surface — the CMD charge-line detail (cmd_explorer_rows): Facility/Month
 * filters, draggable column headers, patient identifiers masked by default and revealed
 * in bulk via "Reveal all" (audited). The former "Payment Type" (daily Checks/EFT/Gross)
 * view was removed; that breakdown lives on the Overview (Master chart + KPI tiles).
 *
 * `view` is the dashboard entity scope (Consolidated/BXR/Indigo) from the top-bar switcher.
 * It is passed to the explorer grid, which sends it to the server actions; the actions
 * re-derive the entitled business_entity_id(s) SERVER-SIDE (clampView + viewToEntityIds,
 * app/lib/views.ts) — the client `view` is a display hint, never trusted for scoping. So the
 * grid, the facility filter, and the audited reveal are all tenant-scoped for cmd_explorer_rows
 * (migration 0028). `canRevealPhi` (admins + super-admins) toggles the audited "Reveal all"
 * control; a plain user never sees it.
 */
import { type DashboardView } from '@/lib/views';
import { CmdCollectionsExplorer } from './cmd-explorer';

export function CollectionsView({
  view,
  canRevealPhi,
}: {
  view: DashboardView;
  canRevealPhi: boolean;
}) {
  return <CmdCollectionsExplorer view={view} canRevealPhi={canRevealPhi} />;
}
