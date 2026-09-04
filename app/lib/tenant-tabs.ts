import type { DashboardView } from '@/lib/views';

/** Whether the tenant tabs have more than one entitled view to switch between. */
export function tenantTabsVisible(allowedViews?: DashboardView[]): allowedViews is DashboardView[] {
  return (allowedViews?.length ?? 0) > 1;
}
