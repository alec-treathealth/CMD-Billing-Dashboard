'use client';

/**
 * Shared dashboard widget primitives — the loading/error card shell, the
 * once-on-mount data hook, and the proportional MiniBar. Used by every dashboard
 * surface (overview / payers / collections). Non-PHI, aggregate-only.
 */
import { useEffect, useState } from 'react';

import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import type { DashboardResult } from '@/lib/actions';

export type WidgetState<T> =
  | { status: 'loading' }
  | { status: 'error' }
  | { status: 'ready'; data: T };

/** Run a dashboard action once on mount; expose loading/error/ready state. */
export function useWidget<T>(action: () => Promise<DashboardResult<T>>): WidgetState<T> {
  const [state, setState] = useState<WidgetState<T>>({ status: 'loading' });
  useEffect(() => {
    let live = true;
    action()
      .then((r) => {
        if (!live) return;
        setState(r.ok ? { status: 'ready', data: r.data } : { status: 'error' });
      })
      .catch(() => {
        if (live) setState({ status: 'error' });
      });
    return () => {
      live = false;
    };
    // action identity is stable (module-level server action); run once.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return state;
}

export function WidgetCard({
  title,
  state,
  children,
}: {
  title: string;
  state: { status: string };
  children: React.ReactNode;
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">{title}</CardTitle>
      </CardHeader>
      <CardContent>
        {state.status === 'loading' && (
          <div className="space-y-2">
            <Skeleton className="h-4 w-3/4" />
            <Skeleton className="h-4 w-1/2" />
            <Skeleton className="h-4 w-2/3" />
          </div>
        )}
        {state.status === 'error' && (
          <div className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
            Unable to load this metric.
          </div>
        )}
        {state.status === 'ready' && children}
      </CardContent>
    </Card>
  );
}

/**
 * A big-number KPI tile (the TreatHealthOS "KPI tile" — see docs/design-system.md).
 * `detail` renders a second, smaller value line; `sub` a muted footnote. Both accept
 * a ReactNode so callers can pass a colored trend/breakdown, not just a string.
 * Shared by the Collections MTD/YTD widget and the overview KPI row.
 */
export function Kpi({
  label,
  value,
  detail,
  sub,
}: {
  label: string;
  value: string;
  detail?: React.ReactNode;
  sub?: React.ReactNode;
}) {
  return (
    <Card className="border-t-2 border-t-[var(--brand-accent)]">
      <CardContent className="pb-4 pt-4">
        <div className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
          {label}
        </div>
        <div className="ths-num mt-1 whitespace-nowrap text-lg font-semibold leading-tight tabular-nums text-[var(--brand-ink)] lg:text-xl">
          {value}
        </div>
        {detail && (
          <div className="ths-num mt-0.5 whitespace-nowrap text-xs tabular-nums text-muted-foreground">
            {detail}
          </div>
        )}
        {sub && <div className="mt-1 text-[11px] text-muted-foreground">{sub}</div>}
      </CardContent>
    </Card>
  );
}

/** A proportional bar (0–100). Values are also shown as text; bar reinforces them. */
export function MiniBar({ pct }: { pct: number | null }) {
  const w = Math.max(0, Math.min(100, pct ?? 0));
  return (
    <div className="h-2.5 w-full overflow-hidden rounded-full bg-[var(--brand-soft)]">
      <div
        className="h-full rounded-full bg-[var(--brand-ink)]"
        style={{ width: `${Math.max(w, w > 0 ? 3 : 0)}%` }}
      />
    </div>
  );
}
