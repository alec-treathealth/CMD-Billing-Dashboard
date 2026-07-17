'use client';

/**
 * Entity <select> for the Manage Users role/entity picker — a pure presentational leaf shared by the
 * invite form and the per-row editor (user-manager.tsx). Rendered standalone in test/user-form.test.tsx
 * (the full UserManager can't load under `node --test`: it pulls the 'use server' admin-actions chain,
 * which imports supabase-admin / next/headers).
 *
 * The whole point of this leaf: an ENTITY-LESS role (super_admin or admissions_seat — see
 * isEntityLessRole) renders a single disabled "—" and never an entity option, so the operator can't
 * pick an entity the server will reject. The not-yet-assigned '' role is treated the same (nothing to
 * scope yet). value is forced to '' when entity-less, so a stale draft entity can never be displayed.
 */
import type { AppEntity, AppRole } from '@/lib/server';
import { isEntityLessRole } from '@/lib/admin/user-form';

export const SELECT_CLASS =
  'h-8 rounded-md border border-line bg-card px-2 text-[13px] text-ink900 disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--brand-accent)]';

export const ENTITY_LABEL: Record<AppEntity, string> = { bxr: 'BXR', indigo: 'Indigo' };

export function EntityCell({
  role,
  entity,
  assignableEntities,
  ariaLabel,
  disabled = false,
  className = SELECT_CLASS,
  onChange,
}: {
  role: AppRole | '';
  entity: AppEntity | '';
  assignableEntities: AppEntity[];
  ariaLabel: string;
  disabled?: boolean;
  className?: string;
  onChange: (entity: AppEntity | '') => void;
}) {
  // Entity-less roles (and the not-yet-assigned '' role) carry no entity: disabled, single "—".
  const entityLess = isEntityLessRole(role) || role === '';
  return (
    <select
      className={className}
      value={entityLess ? '' : entity}
      aria-label={ariaLabel}
      disabled={disabled || entityLess}
      onChange={(e) => onChange(e.target.value as AppEntity | '')}
    >
      {entityLess ? (
        <option value="">—</option>
      ) : (
        assignableEntities.map((en) => (
          <option key={en} value={en}>
            {ENTITY_LABEL[en]}
          </option>
        ))
      )}
    </select>
  );
}
