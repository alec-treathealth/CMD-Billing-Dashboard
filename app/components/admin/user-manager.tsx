'use client';

/**
 * User-management table (admins + super_admins). Lists Supabase Auth users + their dashboard role and
 * lets the caller assign / change / revoke roles within their scope (a super_admin manages everyone and
 * all entities; an entity admin manages only their own entity + unprovisioned users). Controls are shaped
 * by the caller's entitlement passed from the server, and EVERY mutation is re-authorized server-side in
 * the Server Actions — the client shaping is convenience, never the gate. Your own row is read-only.
 */
import { useState, useTransition } from 'react';
import { Button } from '@/components/ui/button';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import {
  revokeUser,
  setUserRole,
  type ManageContext,
  type ManagedUserDto,
} from '@/lib/admin-actions';
import type { AppEntity, AppRole } from '@/lib/server';

const ROLE_LABEL: Record<AppRole, string> = {
  super_admin: 'Super Admin',
  admin: 'Admin',
  user: 'User',
};
const ENTITY_LABEL: Record<AppEntity, string> = { bxr: 'BXR', indigo: 'Indigo' };

const SELECT_CLASS =
  'h-8 rounded-md border border-line bg-card px-2 text-[13px] text-ink900 disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--brand-accent)]';

/** Per-row editable state: '' represents "no role / no entity" (unprovisioned, or N/A for super_admin). */
interface Draft {
  role: AppRole | '';
  entity: AppEntity | '';
}

function draftFromUser(u: ManagedUserDto): Draft {
  return { role: u.role ?? '', entity: u.entity ?? '' };
}

export function UserManager({ initial }: { initial: ManageContext }) {
  const [users, setUsers] = useState<ManagedUserDto[]>(initial.users);
  const [drafts, setDrafts] = useState<Record<string, Draft>>(
    () => Object.fromEntries(initial.users.map((u) => [u.userId, draftFromUser(u)])),
  );
  const [rowMsg, setRowMsg] = useState<Record<string, { kind: 'ok' | 'err'; text: string }>>({});
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [, startTransition] = useTransition();

  const { assignableRoles, assignableEntities } = initial;

  function patchDraft(userId: string, patch: Partial<Draft>) {
    setDrafts((prev) => {
      const next: Draft = { ...prev[userId]!, ...patch };
      // Coherence in the UI: super_admin carries no entity; a freshly-chosen entity role gets a default.
      if (patch.role !== undefined) {
        if (patch.role === 'super_admin') next.entity = '';
        else if (patch.role !== '' && next.entity === '') next.entity = assignableEntities[0] ?? '';
      }
      return { ...prev, [userId]: next };
    });
  }

  function isDirty(u: ManagedUserDto): boolean {
    const d = drafts[u.userId]!;
    return d.role !== (u.role ?? '') || d.entity !== (u.entity ?? '');
  }

  function canSave(u: ManagedUserDto): boolean {
    const d = drafts[u.userId]!;
    if (!isDirty(u) || d.role === '') return false;
    return d.role === 'super_admin' || d.entity !== '';
  }

  function applyResult(userId: string, role: AppRole | null, entity: AppEntity | null) {
    setUsers((prev) => prev.map((u) => (u.userId === userId ? { ...u, role, entity } : u)));
    setDrafts((prev) => ({ ...prev, [userId]: { role: role ?? '', entity: entity ?? '' } }));
  }

  function onSave(u: ManagedUserDto) {
    const d = drafts[u.userId]!;
    if (d.role === '') return;
    const role = d.role;
    const entity = role === 'super_admin' ? null : (d.entity || null) as AppEntity | null;
    setPendingId(u.userId);
    setRowMsg((m) => ({ ...m, [u.userId]: undefined as never }));
    startTransition(async () => {
      const res = await setUserRole(u.userId, role, entity);
      setPendingId(null);
      if (res.ok) {
        applyResult(u.userId, role, entity);
        setRowMsg((m) => ({ ...m, [u.userId]: { kind: 'ok', text: 'Saved' } }));
      } else {
        setRowMsg((m) => ({ ...m, [u.userId]: { kind: 'err', text: res.error } }));
      }
    });
  }

  function onRevoke(u: ManagedUserDto) {
    setPendingId(u.userId);
    setRowMsg((m) => ({ ...m, [u.userId]: undefined as never }));
    startTransition(async () => {
      const res = await revokeUser(u.userId);
      setPendingId(null);
      if (res.ok) {
        applyResult(u.userId, null, null);
        setRowMsg((m) => ({ ...m, [u.userId]: { kind: 'ok', text: 'Revoked' } }));
      } else {
        setRowMsg((m) => ({ ...m, [u.userId]: { kind: 'err', text: res.error } }));
      }
    });
  }

  return (
    <div className="space-y-3">
      <div className="overflow-x-auto rounded-md border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>User</TableHead>
              <TableHead>Role</TableHead>
              <TableHead>Entity</TableHead>
              <TableHead className="text-right">Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {users.map((u) => {
              const d = drafts[u.userId]!;
              const busy = pendingId === u.userId;
              const msg = rowMsg[u.userId];
              const isSelf = u.userId === initial.callerUserId;
              return (
                <TableRow key={u.userId} className="align-top">
                  <TableCell>
                    <div className="flex items-center gap-2">
                      <span className="text-ink900">{u.email}</span>
                      {isSelf && (
                        <span className="rounded bg-[var(--brand-soft)] px-1.5 py-0.5 text-[10px] font-semibold uppercase text-[var(--brand-ink)]">
                          you
                        </span>
                      )}
                    </div>
                    <div className="mt-0.5 text-[11px] text-ink400">
                      {u.emailConfirmed ? 'Confirmed' : 'Invite pending'}
                      {u.role === null && ' · unprovisioned'}
                    </div>
                  </TableCell>

                  {/* Role */}
                  <TableCell>
                    {u.editable ? (
                      <select
                        className={SELECT_CLASS}
                        value={d.role}
                        aria-label={`Role for ${u.email}`}
                        disabled={busy}
                        onChange={(e) => patchDraft(u.userId, { role: e.target.value as AppRole | '' })}
                      >
                        <option value="">— none —</option>
                        {assignableRoles.map((r) => (
                          <option key={r} value={r}>
                            {ROLE_LABEL[r]}
                          </option>
                        ))}
                      </select>
                    ) : (
                      <span className="text-sm text-ink900">{u.role ? ROLE_LABEL[u.role] : '—'}</span>
                    )}
                  </TableCell>

                  {/* Entity */}
                  <TableCell>
                    {u.editable ? (
                      <select
                        className={SELECT_CLASS}
                        value={d.entity}
                        aria-label={`Entity for ${u.email}`}
                        disabled={busy || d.role === 'super_admin' || d.role === ''}
                        onChange={(e) =>
                          patchDraft(u.userId, { entity: e.target.value as AppEntity | '' })
                        }
                      >
                        {d.role === 'super_admin' || d.role === '' ? (
                          <option value="">—</option>
                        ) : (
                          assignableEntities.map((en) => (
                            <option key={en} value={en}>
                              {ENTITY_LABEL[en]}
                            </option>
                          ))
                        )}
                      </select>
                    ) : (
                      <span className="text-sm text-ink900">{u.entity ? ENTITY_LABEL[u.entity] : '—'}</span>
                    )}
                  </TableCell>

                  {/* Actions */}
                  <TableCell className="text-right">
                    {u.editable ? (
                      <div className="flex items-center justify-end gap-2">
                        {msg && (
                          <span
                            className={`text-xs ${msg.kind === 'ok' ? 'text-ink400' : 'text-destructive'}`}
                          >
                            {msg.text}
                          </span>
                        )}
                        {u.role !== null && (
                          <Button
                            type="button"
                            variant="ghost"
                            size="sm"
                            disabled={busy}
                            onClick={() => onRevoke(u)}
                            className="text-destructive hover:text-destructive"
                          >
                            Revoke
                          </Button>
                        )}
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          disabled={busy || !canSave(u)}
                          onClick={() => onSave(u)}
                        >
                          {busy ? 'Saving…' : 'Save'}
                        </Button>
                      </div>
                    ) : (
                      <span className="text-xs text-ink400">{isSelf ? '—' : 'Not in your scope'}</span>
                    )}
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </div>

      <p className="text-xs text-muted-foreground">
        Don&rsquo;t see someone? Invite them in Supabase first (Authentication → Users → Invite); they
        appear here as <span className="font-medium">unprovisioned</span> once invited, ready to assign a
        role. You can&rsquo;t change your own role.
      </p>
    </div>
  );
}
