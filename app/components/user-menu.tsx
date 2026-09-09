'use client';

/**
 * Top-bar user avatar — initials derived from the signed-in email, with a click-to-open
 * menu showing the full email and a Sign out action. Sits at the top-most-right of the
 * global header. The email is passed from the server layout (session read server-side);
 * this component holds no secret and makes no data call — Sign out posts the existing
 * `signOut` server action. Closes on outside-click or Escape.
 *
 * ── SPLIT (Qodo #343 finding 1) ──────────────────────────────────────────────────────────────────
 * The menu BODY is a pure leaf, `UserMenuItems`, and the client shell only owns `open`. Which
 * entries render for which flags is a MARKUP question and is asserted by string render in
 * app/test/user-menu.test.tsx — the same leaf/island split payer-alias-leaves.tsx uses. It used to
 * be asserted through jsdom (mount, click, read the DOM); CLAUDE.md sanctions jsdom for FOCUS and
 * KEYBOARD claims only, and that use forced a `self` global into the shared jsdom helper for every
 * test that will ever mount a <Link>. The leaf removes the reason for both.
 */
import { useEffect, useRef, useState, type ReactNode } from 'react';
import Link from 'next/link';
import { signOut } from '@/lib/auth-actions';

/** Initials from an email local-part: first letters of up to two name tokens, else first two chars. */
function initialsFromEmail(email: string): string {
  const local = (email.split('@')[0] ?? email).trim();
  const parts = local.split(/[._+-]+/).filter(Boolean);
  if (parts.length >= 2) return (parts[0]![0]! + parts[1]![0]!).toUpperCase();
  return local.slice(0, 2).toUpperCase() || '?';
}

const ITEM_CLASS =
  'block border-b border-line px-3 py-2 text-left text-sm text-ink900 transition-colors hover:bg-teal50';

export interface UserMenuFlags {
  canManageUsers?: boolean;
  canViewUserLogs?: boolean;
  /** super_admin with a real principal — resolved server-side in the layout, NOT canManageUsers. */
  canRulePayerAliases?: boolean;
}

/**
 * The menu body — header, the role-dependent entries, and a footer slot for the Sign out form.
 * PURE: no state, no effects, no data access. Renders identically under renderToStaticMarkup and
 * in the browser, which is what lets the entry set be locked by the hermetic suite without jsdom.
 *
 * Entry ORDER is part of the contract (asserted): Manage users · User logs · Payer aliases.
 */
export function UserMenuItems({
  email,
  canManageUsers = false,
  canViewUserLogs = false,
  canRulePayerAliases = false,
  onNavigate,
  footer,
}: UserMenuFlags & {
  email: string;
  /** Called when an entry is chosen — the shell uses it to close the menu. Ignored by string render. */
  onNavigate?: () => void;
  /** The Sign out form, owned by the shell so the leaf stays free of server-action references. */
  footer?: ReactNode;
}): ReactNode {
  return (
    <div
      role="menu"
      className="absolute right-0 z-50 mt-2 w-56 overflow-hidden rounded-md border border-line bg-surface text-ink900 shadow-ths-lg"
    >
      <div className="border-b border-line px-3 py-2">
        <div className="text-[11px] uppercase tracking-wide text-ink400">Signed in as</div>
        <div className="truncate text-sm text-ink900" title={email}>
          {email}
        </div>
      </div>
      {canManageUsers && (
        <Link href="/admin/users" role="menuitem" onClick={onNavigate} className={ITEM_CLASS}>
          Manage users
        </Link>
      )}
      {canViewUserLogs && (
        <Link href="/admin/user-logs" role="menuitem" onClick={onNavigate} className={ITEM_CLASS}>
          User logs
        </Link>
      )}
      {canRulePayerAliases && (
        <Link href="/admin/payer-aliases" role="menuitem" onClick={onNavigate} className={ITEM_CLASS}>
          Payer aliases
        </Link>
      )}
      {footer}
    </div>
  );
}

export function UserMenu({
  email,
  canManageUsers = false,
  canViewUserLogs = false,
  canRulePayerAliases = false,
}: UserMenuFlags & { email: string }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function onDocClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') setOpen(false);
    }
    document.addEventListener('mousedown', onDocClick);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDocClick);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`Account menu for ${email}`}
        title={email}
        className="flex h-8 w-8 items-center justify-center rounded-full bg-white/10 text-xs font-semibold text-white ring-1 ring-white/30 transition-colors hover:bg-white/20"
      >
        {initialsFromEmail(email)}
      </button>

      {open && (
        <UserMenuItems
          email={email}
          canManageUsers={canManageUsers}
          canViewUserLogs={canViewUserLogs}
          canRulePayerAliases={canRulePayerAliases}
          onNavigate={() => setOpen(false)}
          footer={
            <form action={signOut}>
              <button
                type="submit"
                role="menuitem"
                className="block w-full px-3 py-2 text-left text-sm text-ink900 transition-colors hover:bg-teal50"
              >
                Sign out
              </button>
            </form>
          }
        />
      )}
    </div>
  );
}
