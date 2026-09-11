'use client';

/**
 * The facility checkbox list for provisioning a `user` seat (migration 0112).
 *
 * Rendered ONLY when the selected role is `user` — every other role is whole-tenant (admin) or
 * cross-tenant (super_admin / admissions_seat) and the read path never consults a grant for them,
 * so showing a list would imply a restriction that is not enforced.
 *
 * ⚠ AN EMPTY SELECTION IS "SEES NOTHING", NEVER "SEES EVERYTHING". The count line says so in words,
 * because a checkbox list with nothing ticked reads as "no filter applied" in most software and
 * here it means the opposite. Provisioning refuses an empty grant (validateFacilityGrant) and the
 * read path fails closed on one independently.
 *
 * Options are filtered to the SELECTED TENANT by the caller — a grant may never span tenants
 * (ruling R3), and the one-entity CHECK on claims.app_user makes a cross-tenant `user` impossible
 * anyway. Non-PHI throughout: facility codes and names are reference data.
 */
import type { AppEntity } from '@/lib/server';
import type { AssignableFacility } from '@/lib/admin-actions';

/** Care-setting groups, in render order. `null` (unclassified) sorts last under "Other". */
const GROUPS: ReadonlyArray<{ key: 'IP' | 'OP' | 'BOTH' | 'other'; label: string }> = [
  { key: 'IP', label: 'Inpatient' },
  { key: 'OP', label: 'Outpatient' },
  { key: 'BOTH', label: 'Inpatient + Outpatient' },
  { key: 'other', label: 'Other' },
];

function groupOf(f: AssignableFacility): 'IP' | 'OP' | 'BOTH' | 'other' {
  return f.careSetting ?? 'other';
}

export function FacilityPicker({
  facilities,
  entity,
  selected,
  disabled,
  onChange,
  idPrefix,
}: {
  facilities: readonly AssignableFacility[];
  /** The tenant currently chosen for this user; null shows the empty-state prompt. */
  entity: AppEntity | '';
  selected: readonly string[];
  disabled?: boolean;
  onChange: (next: string[]) => void;
  /** Unique per instance — the invite form and each row render their own list on one page. */
  idPrefix: string;
}) {
  if (!entity) {
    return (
      <p className="text-[12px] text-ink400">
        Choose a tenant first — facilities are listed per tenant.
      </p>
    );
  }

  const options = facilities.filter((f) => f.entity === entity);
  const chosen = new Set(selected);

  function toggle(code: string) {
    const next = new Set(chosen);
    if (next.has(code)) next.delete(code);
    else next.add(code);
    onChange([...next]);
  }

  function setGroup(codes: string[], on: boolean) {
    const next = new Set(chosen);
    for (const c of codes) {
      if (on) next.add(c);
      else next.delete(c);
    }
    onChange([...next]);
  }

  if (options.length === 0) {
    return <p className="text-[12px] text-ink400">No facilities are available for this tenant.</p>;
  }

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        {/* The count is the safety copy: "0 selected" must never be mistaken for "unrestricted". */}
        <span className="text-[12px] font-semibold text-ink900">
          {chosen.size} of {options.length} selected
        </span>
        {chosen.size === 0 ? (
          <span className="text-[12px] text-status-danger">
            This user will see no data until at least one facility is selected.
          </span>
        ) : null}
        <button
          type="button"
          disabled={disabled}
          onClick={() => setGroup(options.map((o) => o.code), true)}
          className="text-[12px] font-semibold text-[var(--brand-accent)] underline-offset-2 hover:underline disabled:opacity-50"
        >
          Select all
        </button>
        <button
          type="button"
          disabled={disabled}
          onClick={() => onChange([])}
          className="text-[12px] font-semibold text-ink400 underline-offset-2 hover:underline disabled:opacity-50"
        >
          Clear
        </button>
      </div>

      <div className="max-h-64 space-y-3 overflow-y-auto rounded-md border border-line bg-ground p-2">
        {GROUPS.map((g) => {
          const inGroup = options.filter((o) => groupOf(o) === g.key);
          if (inGroup.length === 0) return null;
          const codes = inGroup.map((o) => o.code);
          const allOn = codes.every((c) => chosen.has(c));
          return (
            <fieldset key={g.key} className="space-y-1">
              <legend className="flex w-full items-center gap-2 text-[11px] font-semibold uppercase tracking-wide text-ink400">
                {g.label}
                <button
                  type="button"
                  disabled={disabled}
                  onClick={() => setGroup(codes, !allOn)}
                  className="text-[11px] font-semibold normal-case text-[var(--brand-accent)] underline-offset-2 hover:underline disabled:opacity-50"
                >
                  {allOn ? 'none' : 'all'}
                </button>
              </legend>
              <div className="grid grid-cols-1 gap-x-4 gap-y-0.5 sm:grid-cols-2">
                {inGroup.map((f) => {
                  const id = `${idPrefix}-${f.code}`;
                  return (
                    <label
                      key={f.code}
                      htmlFor={id}
                      className="flex items-center gap-2 text-[13px] text-ink900"
                    >
                      <input
                        id={id}
                        type="checkbox"
                        disabled={disabled}
                        checked={chosen.has(f.code)}
                        onChange={() => toggle(f.code)}
                        className="h-3.5 w-3.5 shrink-0 accent-[var(--brand-accent)]"
                      />
                      <span className="truncate" title={`${f.name} (${f.code})`}>
                        {f.name}
                      </span>
                      {/* Retired = owned but no longer polled from CMD. Still grantable so the
                          user keeps its HISTORY, but flagged: granting only retired facilities
                          produces a seat that sees nothing current. */}
                      {f.retired ? (
                        <span className="shrink-0 rounded bg-ink400/10 px-1 text-[10px] font-semibold uppercase text-ink400">
                          retired
                        </span>
                      ) : null}
                    </label>
                  );
                })}
              </div>
            </fieldset>
          );
        })}
      </div>
    </div>
  );
}
