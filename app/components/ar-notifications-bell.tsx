'use client';

/**
 * The header BELL — super-admins only (the layout renders it for that role alone; the actions
 * re-gate). Polls the AR event feed on mount, on window focus and every 60s; shows the unread count;
 * the menu lists recent changes by OTHER people (note added / status moved / assigned / due /
 * resolution), each naming the facility, a short claim tail and the actor — never a patient.
 * Clicking an item stores the claim in the in-memory hand-off and navigates to the tab, where the
 * workbench opens the drawer. "Mark all read" moves the caller's cursor.
 *
 * SPLIT: `BellMenuItems` + `describeEvent` are pure leaves in ar-notifications-bell-leaves.tsx
 * (string-render tested); this shell owns polling + open state and is the only file that imports
 * the Server Actions.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Bell } from 'lucide-react';
import { loadArNotificationsAction, markArNotificationsSeenAction } from '@/lib/ar/actions';
import type { ArNotificationRow, ArNotificationsPayload } from '@/lib/ar/contract';
import { setPendingClaim } from '@/lib/ar/open-claim-store';
import { BXR_ENTITY_ID } from '@/lib/views';
import { navHref } from '@/lib/nav-model';
import { BellMenuItems } from './ar-notifications-bell-leaves';

const POLL_MS = 60_000;

export function ArNotificationsBell() {
  const router = useRouter();
  const [payload, setPayload] = useState<ArNotificationsPayload | null>(null);
  const [open, setOpen] = useState(false);
  const [nowMs, setNowMs] = useState<number | null>(null);
  const wrap = useRef<HTMLDivElement>(null);

  const refresh = useCallback(async () => {
    const res = await loadArNotificationsAction();
    if (res.ok) { setPayload(res.payload); setNowMs(Date.now()); }
  }, []);

  useEffect(() => {
    void refresh();
    const id = setInterval(() => void refresh(), POLL_MS);
    const onFocus = () => void refresh();
    window.addEventListener('focus', onFocus);
    return () => { clearInterval(id); window.removeEventListener('focus', onFocus); };
  }, [refresh]);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => { if (wrap.current && !wrap.current.contains(e.target as Node)) setOpen(false); };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', onDoc);
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('mousedown', onDoc); document.removeEventListener('keydown', onKey); };
  }, [open]);

  const unread = payload?.unread ?? 0;
  const markAll = async () => { await markArNotificationsSeenAction(); await refresh(); };
  const openClaim = (e: ArNotificationRow) => {
    const view = e.business_entity_id === BXR_ENTITY_ID ? 'bxr' : 'indigo';
    setPendingClaim({ view, cmdClaimId: e.cmd_claim_id });
    setOpen(false);
    // The URL is built by navHref, NOT by a literal here. `tenant-scope.tsx` is the only
    // interactive writer of ?view= (ruled 2026-09-08, pinned by app/test/tenant-scope.test.tsx):
    // a second client component spelling the param out would be a second switcher by that test's
    // definition, even though this is deep-linking rather than tenant selection. navHref lives in
    // the non-client nav model that already owns view forwarding for every tenant-scoped link, so
    // routing through it keeps one writer and gets encodeURIComponent for free.
    router.push(navHref('/billing-audit', view));
  };

  return (
    <div ref={wrap} className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={unread > 0 ? `AR notifications, ${unread} unread` : 'AR notifications'}
        className="relative inline-flex h-9 w-9 items-center justify-center rounded-full text-white/85 transition-colors hover:bg-white/15 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/60"
      >
        <Bell aria-hidden className="h-[18px] w-[18px]" />
        {unread > 0 ? (
          <span className="ths-num absolute -right-0.5 -top-0.5 inline-flex min-w-[1.125rem] items-center justify-center rounded-full bg-[#E2674F] px-1 text-[12px] font-semibold leading-[1.125rem] text-white ring-2 ring-[var(--brand-bar)]">
            {unread > 99 ? '99+' : unread}
          </span>
        ) : null}
      </button>
      <span className="sr-only" aria-live="polite">{unread > 0 ? `${unread} new AR updates` : ''}</span>
      {open ? <BellMenuItems items={payload?.items ?? []} unread={unread} nowMs={nowMs} onMarkAll={markAll} onOpen={openClaim} /> : null}
    </div>
  );
}
