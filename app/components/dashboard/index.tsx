/**
 * Public surface of the dashboard module — a barrel over the per-surface files so
 * existing imports (`@/components/dashboard`) keep working after the split.
 */
export { Dashboard, ClaimsDistributions } from './overview';
export { PayerChartWidget, PayerDetailExplorer } from './payers';
export { CollectionsSections, CollectionsSummaryWidget } from './collections';
