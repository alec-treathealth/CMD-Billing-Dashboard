/**
 * AR notifications bell — the PURE leaves (`describeEvent`, `BellMenuItems`). No state, no effects, no
 * data access, no Server Action import, so the hermetic suite can string-render them (the shell in
 * ar-notifications-bell.tsx imports Server Actions, whose dependency chain reaches React `cache`,
 * which the test runner's React build does not provide — the payer-alias-leaves.tsx split precedent).
 */
import type { ReactNode } from 'react';
import type { ArNotificationRow } from '@/lib/ar/contract';
import { relativeTime, shortDate } from './billing-audit/ar/ar-leaves';

export function describeEvent(e: ArNotificationRow): string {
  switch (e.event_type) {
    case 'note': return 'added a note';
    case 'status': return `moved ${e.from_value ?? 'open'} → ${e.to_value ?? '—'}`;
    case 'assign': return e.to_value ? `assigned to ${e.to_value.split('@')[0]}` : 'unassigned';
    case 'due': return e.to_value ? `set follow-up ${shortDate(e.to_value)}` : 'cleared the follow-up date';
    case 'resolution': return e.to_value ? `resolution: ${e.to_value}` : 'cleared the resolution';
    default: return e.event_type;
  }
}

export function BellMenuItems({ items, unread, nowMs, onMarkAll, onOpen }: {
  items: ArNotificationRow[];
  unread: number;
  nowMs: number | null;
  onMarkAll?: () => void;
  onOpen?: (e: ArNotificationRow) => void;
}): ReactNode {
  return (
    <div role="menu" aria-label="AR notifications" className="absolute right-0 z-50 mt-2 w-[22rem] overflow-hidden rounded-md border border-line bg-surface text-ink900 shadow-ths-lg">
      <div className="flex items-center justify-between border-b border-line px-3 py-2">
        <div>
          <div className="text-xs uppercase tracking-wide text-ink400">AR changes</div>
          <div className="text-sm text-ink900">{unread === 0 ? 'All caught up' : `${unread} unread`}</div>
        </div>
        {unread > 0 ? (
          <button type="button" role="menuitem" onClick={onMarkAll} className="rounded-md border border-line px-2 py-1 text-xs font-medium text-ink600 hover:bg-teal50">Mark all read</button>
        ) : null}
      </div>
      <ul className="max-h-[24rem] overflow-y-auto">
        {items.length === 0 ? <li className="px-3 py-6 text-center text-sm text-ink400">No changes yet.</li> : null}
        {items.map((e) => (
          <li key={e.id} className="border-b border-line last:border-b-0">
            <button
              type="button"
              role="menuitem"
              onClick={() => onOpen?.(e)}
              className={`flex w-full items-start gap-2 px-3 py-2 text-left transition-colors hover:bg-teal50 ${e.unread ? 'bg-teal50/40' : ''}`}
            >
              <span aria-hidden className={`mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full ${e.unread ? 'bg-[var(--brand-accent)]' : 'bg-transparent'}`} />
              <span className="min-w-0 flex-1">
                <span className="block text-sm text-ink900">
                  <span className="font-semibold">{e.actor_email.split('@')[0]}</span> {describeEvent(e)}
                </span>
                <span className="ths-num block text-xs text-ink400">
                  {e.facility_code ?? '—'} · claim …{e.cmd_claim_id.slice(-4)} · {relativeTime(e.created_at, nowMs) ?? shortDate(e.created_at)}
                </span>
              </span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

