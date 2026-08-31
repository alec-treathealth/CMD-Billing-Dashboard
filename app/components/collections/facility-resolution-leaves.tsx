/**
 * Facility Resolution — PURE presentational leaves.
 *
 * No hooks with effects, no server imports, no '@/' aliases (relative + type-only only), so the
 * hermetic render suite (renderToStaticMarkup under tsx) can load and assert this file directly —
 * the NavRailView / CasesTable convention. All interactivity is passed in as callbacks by the
 * client island (facility-resolution-view.tsx).
 *
 * PHI: rows carry member_id_bidx (a keyed-HMAC token). The ONLY member-shaped thing ever
 * rendered is memberDisplayToken(bidx) — a short prefix of the token, never a raw identifier.
 * Dollar values render in the mono stack with tabular numerals (design-system.md).
 */
import type { ReactNode } from 'react';
import {
  memberDisplayToken,
  resolutionClassOf,
  RESOLUTION_METHODS,
  type ResolutionChip,
  type ResolutionMethod,
  type ResolutionOverviewRow,
  type ResolutionRow,
  type ResolutionSort,
  type ResolutionSortColumn,
} from '../../../src/collections/facilityResolutionQuery.js';

/**
 * The STATUS pill for a RESOLVED row — split by evidence class, ported from the Collections grid's
 * FacilityCell by #294 (2026-08-31).
 *
 * ⚠ THE SPLIT IS THE POINT. Until #294 every resolved method rendered in the same teal pill here,
 * so `member_inference` — a facility we DERIVED from the patient's other charges — looked exactly
 * like `manual`, which a human worked by hand. An attributed facility rendered without its evidence
 * class is a conclusion presented as a fact.
 *
 * THREE CHANNELS, deliberately, because colour alone fails WCAG 1.4.1 in greyscale and in
 * forced-colours mode: border STYLE (solid vs dashed), COLOUR, and the WORD "inferred". Any one of
 * them surviving is enough to tell the two apart.
 *
 * ⚠ `border-dashed` is ALSO used on this page for the unmatched search chip, where it means "not
 * applied". That collision was reviewed and ACCEPTED (ruled 2026-08-31): the border colours differ
 * (border-line there, border-ink400 here), the contexts differ (a search chip vs a status pill),
 * and the word "inferred" carries the meaning regardless. Disambiguating the idiom would be a
 * design-system decision, and that ruling is open — do not invent a third treatment here.
 *
 * The class comes from resolutionClassOf(), the single source of truth, NOT from testing method
 * strings — RESOLUTION_CLASS_BY_METHOD is typed over the full method union, so a seventh method
 * that nobody classified is a typecheck failure rather than a silent "unresolved".
 */
function StatusPill({ method, alias }: { method: ResolutionMethod; alias: string | null }): ReactNode {
  const exact = resolutionClassOf(method) === 'exact';
  const label = METHOD_LABELS[method];
  return (
    <span className="inline-flex items-center gap-1">
      <span
        data-resolution={exact ? 'exact' : 'inferred'}
        className={
          'rounded-full px-2 py-0.5 text-xs font-medium ' +
          (exact
            ? 'border border-teal700/40 bg-teal50 text-teal900'
            : 'border border-dashed border-ink400 bg-surface text-ink600')
        }
      >
        {alias ?? '—'}
      </span>
      <span className="text-xs text-ink400">{exact ? label : `${label} · inferred`}</span>
    </span>
  );
}

export const METHOD_LABELS: Record<ResolutionMethod, string> = {
  manual: 'Manual',
  named: 'Pull provenance',
  member_inference: 'Member inference',
  vob: 'VOB evidence',
  tie_break: 'Tie-break (recency)',
  unresolved: 'Unresolved',
};

const REASON_LABELS: Record<string, string> = {
  no_evidence: 'no evidence',
  provenance_conflict: 'provenance conflict',
  vob_tied: 'VOB tied',
  vob_unmapped: 'VOB label unmapped',
};

export function formatUsd(value: string | null): string {
  if (value === null) return '—';
  const n = Number(value);
  if (!Number.isFinite(n)) return '—';
  return n.toLocaleString('en-US', { style: 'currency', currency: 'USD' });
}

/** Method rollup tiles. Unresolved is surfaced FIRST and accented — it is the page's job. */
export function ResolutionOverviewTiles({ overview }: { overview: ResolutionOverviewRow[] }) {
  const byMethod = new Map(overview.map((r) => [r.method, r]));
  const unresolved = byMethod.get('unresolved');
  const resolvedRows = RESOLUTION_METHODS.filter((m) => m !== 'unresolved')
    .map((m) => byMethod.get(m))
    .filter((r): r is ResolutionOverviewRow => r !== undefined);
  const totalCharges = overview.reduce((a, r) => a + r.charges, 0);
  const totalDollars = overview.reduce((a, r) => a + Number(r.charge_dollars), 0);
  const resolvedDollars = resolvedRows.reduce((a, r) => a + Number(r.charge_dollars), 0);
  const pct = totalDollars > 0 ? Math.round((resolvedDollars / totalDollars) * 1000) / 10 : 0;

  return (
    <section aria-label="Resolution overview" className="space-y-3">
      <p className="text-sm text-ink600">
        <span className="font-mono tabular-nums font-semibold text-ink900">{pct.toFixed(1)}%</span>{' '}
        of{' '}
        <span className="font-mono tabular-nums">
          {totalDollars.toLocaleString('en-US', { style: 'currency', currency: 'USD' })}
        </span>{' '}
        across {totalCharges.toLocaleString('en-US')} charges is attributed.
      </p>
      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
        {unresolved ? (
          <div
            className="rounded-lg border border-coral600/50 border-l-4 border-l-coral600 bg-surface px-3 py-2"
            data-testid="tile-unresolved"
          >
            <div className="text-[11px] font-medium uppercase tracking-wide text-coral600">
              Unresolved
            </div>
            <div className="mt-0.5 font-mono text-lg font-semibold tabular-nums text-ink900">
              {formatUsd(unresolved.charge_dollars)}
            </div>
            <div className="text-xs text-ink600">
              {unresolved.charges.toLocaleString('en-US')} charges ·{' '}
              {unresolved.members.toLocaleString('en-US')} members
            </div>
          </div>
        ) : (
          <div className="rounded-lg border border-line bg-surface px-3 py-2" data-testid="tile-unresolved">
            <div className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
              Unresolved
            </div>
            <div className="mt-0.5 font-mono text-lg font-semibold tabular-nums text-ink900">$0.00</div>
            <div className="text-xs text-ink600">queue is clear</div>
          </div>
        )}
        {resolvedRows.map((r) => (
          <div key={r.method} className="rounded-lg border border-line bg-surface px-3 py-2">
            <div className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
              {METHOD_LABELS[r.method]}
            </div>
            <div className="mt-0.5 font-mono text-lg font-semibold tabular-nums text-ink900">
              {formatUsd(r.charge_dollars)}
            </div>
            <div className="text-xs text-ink600">
              {r.charges.toLocaleString('en-US')} charges · {r.facilities.toLocaleString('en-US')}{' '}
              {r.facilities === 1 ? 'facility' : 'facilities'}
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}

/** One removable search chip; unmatched chips render inert + visibly different (never applied). */
export function ChipRow({
  chips,
  onRemove,
}: {
  chips: ResolutionChip[];
  onRemove?: (index: number) => void;
}) {
  if (chips.length === 0) return null;
  return (
    <ul aria-label="Active search filters" className="flex flex-wrap gap-1.5">
      {chips.map((chip, i) => (
        <li key={`${chip.kind}-${chip.label}-${i}`}>
          {chip.kind === 'unmatched' ? (
            <span
              className="inline-flex items-center gap-1 rounded-full border border-dashed border-line px-2 py-0.5 text-xs text-ink400"
              title="Not understood — this term is not applied"
            >
              <span aria-hidden>?</span>
              {chip.label}
              <span className="sr-only">(not understood; not applied)</span>
            </span>
          ) : (
            <span className="inline-flex items-center gap-1 rounded-full border border-teal700/40 bg-teal50 px-2 py-0.5 text-xs text-teal900">
              {chip.label}
              {onRemove ? (
                <button
                  type="button"
                  aria-label={`Remove filter ${chip.label}`}
                  className="rounded-full px-1 leading-none text-teal700 hover:bg-teal200/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal500/40"
                  onClick={() => onRemove(i)}
                >
                  <span aria-hidden>×</span>
                </button>
              ) : null}
            </span>
          )}
        </li>
      ))}
    </ul>
  );
}

export interface QueueSelection {
  selected: ReadonlySet<number>;
  onToggle: (row: ResolutionRow) => void;
  onToggleAll: (rows: ResolutionRow[]) => void;
}

function SortButton({
  column,
  label,
  sort,
  onSort,
}: {
  column: ResolutionSortColumn;
  label: string;
  sort: ResolutionSort;
  onSort?: (column: ResolutionSortColumn) => void;
}) {
  const active = sort.column === column;
  return (
    <button
      type="button"
      aria-label={`Sort by ${label}`}
      className="inline-flex items-center gap-1 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
      onClick={onSort ? () => onSort(column) : undefined}
    >
      {label}
      <span aria-hidden className="text-ink400">
        {active ? (sort.direction === 'asc' ? '↑' : '↓') : '↕'}
      </span>
    </button>
  );
}

const TH = 'px-3 py-2 text-left text-[11px] font-medium uppercase tracking-wide text-muted-foreground';
const TH_NUM = 'px-3 py-2 text-right text-[11px] font-medium uppercase tracking-wide text-muted-foreground';
const TD = 'px-3 py-2 text-sm text-ink900';
const TD_NUM = 'px-3 py-2 text-right font-mono text-sm tabular-nums text-ink900';

/** The queue table. Sortable on the four allowlisted columns (aria-sort); row selection via
 *  labelled checkboxes; the member cell shows the display TOKEN, never the raw blind index. */
export function QueueTable({
  rows,
  sort,
  onSort,
  selection,
}: {
  rows: ResolutionRow[];
  sort: ResolutionSort;
  onSort?: (column: ResolutionSortColumn) => void;
  selection?: QueueSelection;
}) {
  const allSelected = selection !== undefined && rows.length > 0 && rows.every((r) => selection.selected.has(r.id));
  const ariaSort = (column: ResolutionSortColumn): 'ascending' | 'descending' | undefined =>
    sort.column === column ? (sort.direction === 'asc' ? 'ascending' : 'descending') : undefined;

  return (
    <div className="overflow-x-auto rounded-lg border border-line">
      <table className="w-full min-w-[960px] border-collapse bg-surface">
        <thead className="border-b border-line">
          <tr>
            {selection ? (
              <th scope="col" className={TH}>
                <input
                  type="checkbox"
                  aria-label={allSelected ? 'Deselect all charges on this page' : 'Select all charges on this page'}
                  checked={allSelected}
                  onChange={() => selection.onToggleAll(rows)}
                />
              </th>
            ) : null}
            <th scope="col" className={TH}>
              Member
            </th>
            <th scope="col" className={TH} aria-sort={ariaSort('charge_date')}>
              <SortButton column="charge_date" label="Charge date" sort={sort} onSort={onSort} />
            </th>
            <th scope="col" className={TH} aria-sort={ariaSort('payment_received')}>
              <SortButton column="payment_received" label="Paid date" sort={sort} onSort={onSort} />
            </th>
            <th scope="col" className={TH}>
              CPT
            </th>
            <th scope="col" className={TH_NUM} aria-sort={ariaSort('charge_amount')}>
              <SortButton column="charge_amount" label="Charged" sort={sort} onSort={onSort} />
            </th>
            <th scope="col" className={TH_NUM} aria-sort={ariaSort('insurance_payments')}>
              <SortButton column="insurance_payments" label="Paid" sort={sort} onSort={onSort} />
            </th>
            <th scope="col" className={TH}>
              Payer
            </th>
            <th scope="col" className={TH}>
              Era
            </th>
            <th scope="col" className={TH}>
              Status
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 ? (
            <tr>
              <td className={`${TD} text-ink600`} colSpan={selection ? 10 : 9}>
                No charges match the current filters.
              </td>
            </tr>
          ) : (
            rows.map((r) => (
              <tr key={r.id} className="border-b border-line/60 last:border-b-0">
                {selection ? (
                  <td className={TD}>
                    <input
                      type="checkbox"
                      aria-label={`Select charge of ${formatUsd(r.charge_amount)} on ${r.charge_date} for member ${memberDisplayToken(r.member_id_bidx)}`}
                      checked={selection.selected.has(r.id)}
                      onChange={() => selection.onToggle(r)}
                    />
                  </td>
                ) : null}
                <td className={`${TD} font-mono text-xs tabular-nums`}>
                  {memberDisplayToken(r.member_id_bidx)}
                </td>
                <td className={TD}>{r.charge_date}</td>
                <td className={TD}>{r.payment_received ?? '—'}</td>
                <td className={TD}>{r.cpt_code ?? '—'}</td>
                <td className={TD_NUM}>{formatUsd(r.charge_amount)}</td>
                <td className={TD_NUM}>{formatUsd(r.insurance_payments)}</td>
                <td className={TD}>{r.primary_payer ?? '—'}</td>
                <td className={TD}>
                  <span className="rounded-full border border-line px-2 py-0.5 text-xs text-ink600">
                    {r.source_era}
                  </span>
                </td>
                <td className={TD}>
                  {r.method === 'unresolved' ? (
                    <span className="rounded-full border border-coral600/50 bg-coral50 px-2 py-0.5 text-xs font-medium text-coral600">
                      unresolved · {REASON_LABELS[r.unresolved_reason ?? ''] ?? r.unresolved_reason ?? '—'}
                    </span>
                  ) : (
                    <StatusPill method={r.method} alias={r.facility_alias} />
                  )}
                </td>
              </tr>
            ))
          )}
        </tbody>
      </table>
    </div>
  );
}

/**
 * The assignment dialog's scope + note fields — CONTROLLED, and the single definition of this
 * markup (the island renders exactly this, so there is never a duplicate label or id on the
 * page). Pure: props in, callbacks out, no effects — so renderToStaticMarkup can assert the a11y
 * contract directly. The facility combobox is stateful and is injected as `children`.
 */
export function AssignDialogFields({
  chargeCount,
  memberCount,
  facilityListboxId,
  noteId,
  scopeName,
  scope,
  onScopeChange,
  note,
  onNoteChange,
  children,
}: {
  chargeCount: number;
  memberCount: number;
  facilityListboxId: string;
  noteId: string;
  scopeName: string;
  scope: 'charges' | 'members';
  onScopeChange?: (scope: 'charges' | 'members') => void;
  note: string;
  onNoteChange?: (note: string) => void;
  children?: ReactNode;
}) {
  return (
    <div className="space-y-4">
      <fieldset className="space-y-1">
        <legend className="text-sm font-medium text-ink900">Scope</legend>
        <label className="flex items-center gap-2 text-sm text-ink900">
          <input
            type="radio"
            name={scopeName}
            value="charges"
            checked={scope === 'charges'}
            onChange={onScopeChange ? () => onScopeChange('charges') : undefined}
            readOnly={onScopeChange === undefined}
          />
          Only the {chargeCount.toLocaleString('en-US')} selected {chargeCount === 1 ? 'charge' : 'charges'}
        </label>
        <label className="flex items-center gap-2 text-sm text-ink900">
          <input
            type="radio"
            name={scopeName}
            value="members"
            checked={scope === 'members'}
            onChange={onScopeChange ? () => onScopeChange('members') : undefined}
            readOnly={onScopeChange === undefined}
          />
          Every unresolved charge for the {memberCount.toLocaleString('en-US')} selected{' '}
          {memberCount === 1 ? 'member' : 'members'}
        </label>
      </fieldset>
      {children /* facility combobox (stateful) is injected here by the island */}
      <div className="space-y-1">
        <label htmlFor={noteId} className="text-sm font-medium text-ink900">
          Assignment note <span className="text-coral600">(required — do not include PHI)</span>
        </label>
        <textarea
          id={noteId}
          name="note"
          required
          maxLength={500}
          rows={3}
          value={note}
          onChange={onNoteChange ? (e) => onNoteChange(e.target.value) : undefined}
          readOnly={onNoteChange === undefined}
          className="w-full rounded-md border border-line bg-surface p-2 text-sm text-ink900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          aria-describedby={`${noteId}-hint`}
        />
        <p id={`${noteId}-hint`} className="text-xs text-ink400">
          Why this facility owns these charges. Stored on the audit trail; corrections supersede,
          never overwrite. Max 500 characters.
        </p>
      </div>
      <p className="sr-only" id={`${facilityListboxId}-usage`}>
        Use arrow keys to browse facilities, Enter to choose, Escape to close the list.
      </p>
    </div>
  );
}
