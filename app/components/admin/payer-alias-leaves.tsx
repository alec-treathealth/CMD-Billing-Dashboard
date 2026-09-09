/**
 * Payer-alias ruling queue — PURE presentational leaves.
 *
 * No hooks with effects, no server imports, no '@/' aliases (relative + type-only only), so the
 * hermetic render suite (renderToStaticMarkup under tsx) can load and assert this file directly —
 * the facility-resolution-leaves / NavRailView convention.
 *
 * ── WHAT IS AND IS NOT ON THIS SURFACE ───────────────────────────────────────────────────────────
 * Non-PHI by construction: payer names, payer identifiers, canonical `pi_*` slugs, prose notes. No
 * member, no patient, no dollars — so there is nothing here to omit from the DOM, and nothing is
 * CSS-hidden either (pr_compliance_checklist.yaml:41 fails a PR that hides a value with a class
 * while leaving it in the markup; the rule bites on values that exist, and none do).
 *
 * ⚠️ `alias_norm` IS KEPT OUT OF URLS AS A PRECAUTION — not because a repo rule says to. It CAN be
 * an employer name (`employer_self_funded` is a real relationship), and `employer_name` is in the
 * PhiKey union though ruled display-permissible to an authenticated principal (2026-08-14). That the
 * employer rule extends to this column is an ASSUMPTION of ours; no checklist or rule file covers
 * `alias_norm`. Kept anyway because it costs nothing and the downside of being wrong is bad.
 * NOTHING in this file puts `alias_norm` into an href, a form action, or a data attribute a link
 * consumes: `vocabTabHref` and `pageHref` build from the vocabulary enum and an integer only.
 *
 * READ-ONLY. Artifact 2 has no controls that mutate — no confirm button, no relationship picker.
 * Those arrive with the write chain in Artifact 3.
 */
import type { ReactNode } from 'react';
import {
  defaultRulingRelationship,
  PAYER_ALIAS_RELATIONSHIPS,
  PAYER_ALIAS_VOCABULARIES,
  RELATIONSHIP_REQUIRES_CANONICAL,
  VOB_NAMES_PER_ID,
  type PayerAliasRelationship,
  type RulingAction,
  type PayerAliasNeighbourRow,
  type PayerAliasQueueRow,
  type PayerAliasSiblingRow,
  type PayerAliasVobNameRow,
  type PayerAliasVocabulary,
} from '../../../src/collections/payerAliasQueue.js';

export const VOCAB_LABELS: Record<PayerAliasVocabulary, string> = {
  vob_insurance_co: 'VOB insurance co.',
  claims_primary_payer: 'Claims primary payer',
  vob_payer_id: 'VOB payer ID',
};

/** What the reviewer is actually judging in each tab — the three are not interchangeable. */
export const VOCAB_HINTS: Record<PayerAliasVocabulary, string> = {
  vob_insurance_co: 'A payer NAME as typed on a VOB.',
  claims_primary_payer: 'A payer NAME as it appears in claims.',
  vob_payer_id: 'A payer IDENTIFIER, not a name — it cannot be judged by reading it, and these rows carry no confidence score, so this tab is ordered alphabetically.',
};

const PROVENANCE_LABELS: Record<string, string> = {
  idf_cosine: 'IDF cosine',
  trigram_proposal: 'Trigram',
  no_candidate: 'No candidate',
  vob_payer_id: 'Payer-ID spine',
  human: 'Human',
  exact_match: 'Exact match',
  payer_alias_seed: 'Seed',
};

export function provenanceLabel(p: string): string {
  return PROVENANCE_LABELS[p] ?? p;
}

/** Route builders. Vocabulary is an enum member and page an integer — never `alias_norm`. */
export function vocabTabHref(v: PayerAliasVocabulary): string {
  return `/admin/payer-aliases?v=${encodeURIComponent(v)}`;
}
export function pageHref(v: PayerAliasVocabulary, page: number): string {
  const p = Math.max(1, Math.trunc(page));
  return p <= 1 ? vocabTabHref(v) : `${vocabTabHref(v)}&p=${p}`;
}

/* ── Tabs ─────────────────────────────────────────────────────────────────────────────────────── */

export function VocabularyTabs({
  active,
  counts,
}: {
  active: PayerAliasVocabulary;
  counts: Record<PayerAliasVocabulary, number>;
}): ReactNode {
  return (
    <nav aria-label="Alias vocabulary" className="border-b border-line">
      <ul className="flex flex-wrap gap-1">
        {PAYER_ALIAS_VOCABULARIES.map((v) => {
          const on = v === active;
          return (
            <li key={v}>
              <a
                href={vocabTabHref(v)}
                aria-current={on ? 'page' : undefined}
                className={
                  'inline-flex items-center gap-2 rounded-t-md px-3 py-2 text-sm ' +
                  (on
                    ? 'border-b-2 border-teal700 font-semibold text-teal900'
                    : 'border-b-2 border-transparent text-ink600 hover:text-teal900')
                }
              >
                {VOCAB_LABELS[v]}
                <span
                  className={
                    'rounded-full px-2 py-0.5 text-xs tabular-nums ' +
                    (on ? 'bg-teal50 text-teal900' : 'bg-ground text-ink400')
                  }
                >
                  {counts[v]}
                </span>
              </a>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}

/* ── Row parts ────────────────────────────────────────────────────────────────────────────────── */

/**
 * Confidence as a VALUE, not a bar (ruled 2026-09-05). A bar cannot distinguish 0.510 from 0.94 at
 * a glance without a scale, and the reviewer's whole job is to weigh exactly that difference. The
 * string arrives verbatim from `numeric::text` and is never parsed to a float — a lossy round-trip
 * would be invisible in a UI whose only output is the number itself.
 */
export function ConfidenceValue({ value }: { value: string | null }): ReactNode {
  if (value === null) {
    return (
      <span className="text-xs text-ink400">
        no score<span className="sr-only"> — this row carries no confidence value</span>
      </span>
    );
  }
  return (
    <span className="font-mono text-xs tabular-nums text-ink900">
      <span className="sr-only">confidence </span>
      {value}
    </span>
  );
}

/**
 * The machine's PROPOSAL, resolved through ref.payer_identity — or an explicit statement that there
 * isn't one. `administers_for` is followed one hop so a TPA proposal reads as the chain it is
 * ("Optum — administers for UnitedHealthcare") rather than as a bare name.
 */
export function ProposalCell({ row }: { row: PayerAliasQueueRow }): ReactNode {
  if (row.canonical_payer_id === null) {
    return (
      <p className="text-sm text-ink600">
        <span className="font-medium text-status-warn">No proposal.</span> Nothing to accept — this
        row needs research before it can be ruled.
      </p>
    );
  }
  return (
    <p className="text-sm text-ink900">
      <span className="font-medium">{row.display_name ?? row.canonical_payer_id}</span>
      <span className="ml-2 font-mono text-xs text-ink400">{row.canonical_payer_id}</span>
      {row.is_active === false ? (
        <span className="ml-2 rounded-full bg-coral50 px-2 py-0.5 text-xs text-status-danger">
          identity inactive
        </span>
      ) : null}
      <span className="ml-2 block text-xs text-ink600">
        {[row.payer_family, row.entity_kind].filter(Boolean).join(' · ') || 'unclassified'}
        {row.administers_for !== null
          ? ` · administers for ${row.administers_for_name ?? row.administers_for}`
          : ''}
      </span>
    </p>
  );
}

/**
 * The 029 review note, RENDERED IN FLOW — never a tooltip or a title= attribute. Ten rows carry a
 * `STRUCTURALLY AMBIGUOUS —` note written by a human who already looked at them; that is decision
 * input, and hiding it behind a hover makes it invisible on touch and to a screen reader.
 */
export function ReviewNote({ note }: { note: string | null }): ReactNode {
  if (note === null || note.trim() === '') return null;
  return (
    <p className="mt-2 rounded-md border-l-2 border-status-warn bg-ground px-3 py-2 text-xs text-ink600">
      <span className="font-semibold text-ink900">Review note: </span>
      {note}
    </p>
  );
}

function rulingSummary(relationship: string, displayName: string | null, canonical: string | null): string {
  if (canonical === null) return relationship;
  return `${relationship} → ${displayName ?? canonical}`;
}

/** The same string as ruled under the OTHER vocabularies — keeps the crosswalk halves consistent. */
export function SiblingList({ siblings }: { siblings: readonly PayerAliasSiblingRow[] }): ReactNode {
  if (siblings.length === 0) return null;
  return (
    <div className="mt-2">
      <h4 className="text-xs font-semibold uppercase tracking-wide text-ink400">
        Same string, other vocabularies
      </h4>
      <ul className="mt-1 space-y-0.5">
        {siblings.map((s) => (
          <li key={`${s.vocabulary}:${s.alias_norm}`} className="text-xs text-ink600">
            <span className="font-medium text-ink900">{VOCAB_LABELS[s.vocabulary as PayerAliasVocabulary] ?? s.vocabulary}</span>
            {' — '}
            {rulingSummary(s.relationship, s.display_name, s.canonical_payer_id)}
            {s.needs_review ? (
              <span className="ml-2 rounded-full bg-ground px-2 py-0.5 text-status-warn">also unruled</span>
            ) : (
              <span className="ml-2 rounded-full bg-teal50 px-2 py-0.5 text-teal900">confirmed</span>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}

/**
 * CONFIRMED look-alikes off the existing trigram GIN index. Filtered to already-ruled rows on
 * purpose: the question is "how were strings like this one ALREADY ruled?", and a similar row that
 * is itself unruled answers nothing. An empty list is itself a signal — no precedent exists.
 */
export function NeighbourList({ neighbours }: { neighbours: readonly PayerAliasNeighbourRow[] }): ReactNode {
  if (neighbours.length === 0) {
    return (
      <p className="mt-2 text-xs text-ink400">No confirmed look-alikes — no precedent to lean on.</p>
    );
  }
  return (
    <div className="mt-2">
      <h4 className="text-xs font-semibold uppercase tracking-wide text-ink400">
        Confirmed look-alikes
      </h4>
      <ul className="mt-1 space-y-0.5">
        {neighbours.map((n) => (
          <li key={`${n.vocabulary}:${n.alias_norm}`} className="text-xs text-ink600">
            <span className="font-mono text-ink900">{n.alias_norm}</span>
            <span className="ml-2 font-mono tabular-nums text-ink400">
              <span className="sr-only">similarity </span>
              {n.similarity}
            </span>
            {' — '}
            {rulingSummary(n.relationship, n.display_name, n.canonical_payer_id)}
          </li>
        ))}
      </ul>
    </div>
  );
}

/* ── VOB names behind a payer id ──────────────────────────────────────────────────────────────── */

/**
 * From how many names does the reveal stop helping? Chosen against the measured distribution of
 * names-per-id over the 359 vob_payer_id rows (2026-09-07): median 2, mean 9.36, p90 13.2, max 369.
 *
 * The cap (12) sits at p90, so nine cards in ten show every name whole. Above the cap, the 12
 * heaviest names are still MOST of the names while the total is ≤ 24 — the omitted set is smaller
 * than the shown one, and "showing 12 of 19" is honest progress. From 25 the omitted names OUTNUMBER
 * the shown, and with a tail that runs to 369 the gap only widens: twelve names cannot describe an
 * id that 369 payers file under. That id is not one payer's, and a list will not make it one. So the
 * card says that in one line instead of presenting 12 of 369 as if it were the same disclosure as
 * 12 of 19.
 *
 * 2 × cap + 1, written out so the relationship to the cap IS the constant, not a magic number.
 */
export const VOB_NAMES_UNHELPFUL_FROM = VOB_NAMES_PER_ID * 2 + 1;

const fmtInt = (n: number): string => n.toLocaleString('en-US');

/**
 * The VOB names filed under a payer id — the evidence a reviewer needs to judge an identifier that
 * cannot be judged by reading it. Rendered ONLY for vob_payer_id rows (QueueCard gates on the
 * vocabulary); for a name vocabulary the join is meaningless and the loader sends nothing.
 *
 * Renderings, from the same measured distribution:
 *   · 1 name   — inline, uncollapsed. 48% of cards. A "1 name" disclosure implies an ambiguity that
 *                does not exist; what the card is saying is that this id means one name.
 *   · 2–12     — one <details>, every name (the cap covers them all).
 *   · 13–24    — one <details>, the 12 heaviest, plus an overflow line naming what is not shown.
 *   · ≥ 25     — one line saying the list cannot help, and no list. See VOB_NAMES_UNHELPFUL_FROM.
 *   · 0        — one line stating the absence (the bare-equality join found no VOB row for this id).
 *   · members, no names — one line saying so. NOT the 0 case: rows exist, none carries a company
 *                name. total_members counts them; nothing is listed (Qodo #343 finding 2).
 *
 * ⚠️ COLLAPSE IS PRESENTATION, NOT CONTAINMENT. A closed <details> still serialises its children:
 * every name in the 2–24 renderings is in the HTML whether or not the reader has opened it. That is
 * fine here — payer names, non-PHI by construction — and nothing is hidden for compliance reasons
 * (pr_compliance_checklist.yaml's hidden-value rule is about values that must NOT ship at all). The
 * render suite asserts the names ARE in the markup precisely so nobody later reads the <details> as
 * a boundary and puts something behind it that needed one.
 */
export function VobNameList({ names }: { names: readonly PayerAliasVobNameRow[] }): ReactNode {
  const first = names[0];
  if (first === undefined) {
    return <p className="mt-2 text-xs text-ink400">No VOB row carries this payer id verbatim.</p>;
  }
  const totalNames = first.total_names;
  const totalMembers = first.total_members;
  // Qodo #343 finding 2: total_members counts EVERY member under the id, named or not. A blank
  // insurance_co is a member without a name, not a missing member, so the figure the card calls
  // "members" must not shrink because a VOB left the company field empty — and when some did, the
  // card says how many, so a reviewer knows the list below does not account for all of them.
  const unnamed = Math.max(0, totalMembers - first.named_members);
  const unnamedNote = unnamed > 0 ? ` · ${fmtInt(unnamed)} without a name` : '';

  if (totalNames === 0) {
    // The MARKER row: members exist under this id but none carries an insurance-company name.
    // This is not "no VOB row" — the id is in use — and there is nothing to list.
    return (
      <p className="mt-2 text-xs text-ink600">
        <span className="font-medium">
          {fmtInt(totalMembers)} VOB {totalMembers === 1 ? 'member carries' : 'members carry'} this payer id
        </span>
        , but none records an insurance-company name — nothing to list.
      </p>
    );
  }

  if (totalNames === 1) {
    return (
      <p className="mt-2 text-xs text-ink600">
        <span className="font-semibold uppercase tracking-wide text-ink400">VOB name </span>
        <span className="font-mono text-ink900">{first.name}</span>
        <span className="ml-2 tabular-nums">
          · {fmtInt(first.members)} {first.members === 1 ? 'member' : 'members'}
          {unnamedNote}
        </span>
      </p>
    );
  }

  if (totalNames >= VOB_NAMES_UNHELPFUL_FROM) {
    return (
      <p className="mt-2 text-xs text-ink600">
        <span className="font-medium text-status-warn">{fmtInt(totalNames)} VOB names</span> share this
        id across {fmtInt(totalMembers)} members{unnamedNote} — too many for a name list to help, so none is shown.
      </p>
    );
  }

  return (
    <details className="mt-2 rounded-lg border border-line bg-surface px-3 py-2">
      <summary className="cursor-pointer text-xs font-semibold text-ink900">
        {fmtInt(totalNames)} VOB names · {fmtInt(totalMembers)} members{unnamedNote}
      </summary>
      <ul className="mt-2 space-y-0.5">
        {names.map((n) => (
          <li key={n.name ?? ''} className="text-xs text-ink600">
            <span className="font-mono text-ink900">{n.name}</span>
            <span className="ml-2 tabular-nums">
              <span className="sr-only">members </span>
              {fmtInt(n.members)}
            </span>
          </li>
        ))}
      </ul>
      {totalNames > names.length ? (
        <p className="mt-2 text-xs tabular-nums text-ink400">
          showing {names.length} of {fmtInt(totalNames)} · {fmtInt(totalMembers)} members{unnamedNote}
        </p>
      ) : null}
    </details>
  );
}

/* ── The card ─────────────────────────────────────────────────────────────────────────────────── */

export function QueueCard({
  row,
  siblings,
  neighbours,
  vobNames,
  renderForm,
}: {
  row: PayerAliasQueueRow;
  siblings: readonly PayerAliasSiblingRow[];
  neighbours: readonly PayerAliasNeighbourRow[];
  /** VOB names behind this id — consulted ONLY when the row's vocabulary is vob_payer_id. */
  vobNames?: readonly PayerAliasVobNameRow[];
  /** Injected by the page so this leaf stays pure and server-import-free. OMITTED → the card is
   *  read-only and emits no controls at all, which is what the render guard asserts. */
  renderForm?: (row: PayerAliasQueueRow) => ReactNode;
}): ReactNode {
  return (
    <li className="rounded-lg border border-line bg-surface p-4">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h3 className="font-mono text-sm font-semibold text-ink900">{row.alias_norm}</h3>
        <div className="flex items-center gap-2">
          <span className="rounded-full bg-ground px-2 py-0.5 text-xs text-ink600">
            {provenanceLabel(row.provenance)}
          </span>
          <ConfidenceValue value={row.confidence} />
        </div>
      </div>
      <div className="mt-2">
        <ProposalCell row={row} />
      </div>
      <ReviewNote note={row.review_note} />
      {/* The alias IS a payer id on this one tab, so the names filed under it are the evidence. On a
          name tab the same data would be meaningless, and the loader does not send it. */}
      {row.vocabulary === 'vob_payer_id' ? <VobNameList names={vobNames ?? []} /> : null}
      <SiblingList siblings={siblings} />
      <NeighbourList neighbours={neighbours} />
      {renderForm ? renderForm(row) : null}
    </li>
  );
}

export function QueueList({
  rows,
  siblings,
  neighbours,
  vobNames = {},
  renderForm,
}: {
  rows: readonly PayerAliasQueueRow[];
  siblings: Record<string, PayerAliasSiblingRow[]>;
  neighbours: Record<string, PayerAliasNeighbourRow[]>;
  /** payer id → VOB names, heaviest first. Empty on the two name tabs. */
  vobNames?: Record<string, PayerAliasVobNameRow[]>;
  renderForm?: (row: PayerAliasQueueRow) => ReactNode;
}): ReactNode {
  if (rows.length === 0) {
    return (
      <p className="rounded-lg border border-dashed border-line bg-ground px-4 py-8 text-center text-sm text-ink600">
        Nothing unruled on this page.
      </p>
    );
  }
  return (
    <ul className="space-y-3">
      {rows.map((row) => (
        <QueueCard
          key={`${row.vocabulary}:${row.alias_norm}`}
          row={row}
          siblings={siblings[row.alias_norm] ?? []}
          neighbours={neighbours[row.alias_norm] ?? []}
          vobNames={vobNames[row.alias_norm] ?? []}
          renderForm={renderForm}
        />
      ))}
    </ul>
  );
}

/* ── Pager ────────────────────────────────────────────────────────────────────────────────────── */

export function Pager({
  vocabulary,
  page,
  pageSize,
  total,
  hasMore,
}: {
  vocabulary: PayerAliasVocabulary;
  page: number;
  pageSize: number;
  total: number;
  hasMore: boolean;
}): ReactNode {
  // ⚠️ THE PAGE IS CLAMPED HERE TOO, NOT ONLY IN THE LOADER (M2, 2026-09-06). `clampPage` bounds a
  // route value to [1, MAX_PAGE] because it cannot know the row count; MAX_PAGE is 200 against a
  // queue of ~990, so `?p=200` produced first=4976, last=990 — an inverted range, rendered as
  // "Showing 4976–990 of 990 unruled". The loader now clamps to the real last page, but this leaf is
  // exported and independently renderable, so it must not depend on a caller having done that: a
  // presentational component handed an out-of-range page should still print a coherent range.
  const lastPage = Math.max(1, Math.ceil(total / pageSize));
  const shown = Math.min(Math.max(1, Math.trunc(page)), lastPage);
  const first = total === 0 ? 0 : (shown - 1) * pageSize + 1;
  const last = Math.min(shown * pageSize, total);
  const linkCls =
    'rounded-md border border-line px-3 py-1.5 text-sm text-ink900 hover:bg-ground';
  const deadCls = 'rounded-md border border-line px-3 py-1.5 text-sm text-ink400';
  return (
    <nav aria-label="Queue pages" className="mt-4 flex items-center justify-between gap-3">
      <p className="text-xs tabular-nums text-ink600">
        {total === 0 ? 'No unruled rows' : `Showing ${first}–${last} of ${total} unruled`}
      </p>
      <div className="flex gap-2">
        {shown > 1 ? (
          <a href={pageHref(vocabulary, shown - 1)} className={linkCls} rel="prev">
            Previous
          </a>
        ) : (
          <span className={deadCls} aria-disabled="true">
            Previous
          </span>
        )}
        {hasMore && shown < lastPage ? (
          <a href={pageHref(vocabulary, shown + 1)} className={linkCls} rel="next">
            Next
          </a>
        ) : (
          <span className={deadCls} aria-disabled="true">
            Next
          </span>
        )}
      </div>
    </nav>
  );
}

/* ══════════════════════════════════════════════════════════════════════════════════════════════════
 * THE RULING FORM — the ONLY part of this surface that emits controls.
 *
 * Everything above is read-only and the render suite asserts it stays that way: a control appearing
 * in QueueList, NeighbourList, SiblingList, Pager, VocabularyTabs, ProposalCell, ReviewNote or
 * ConfidenceValue is a test failure. The exemption is scoped to RulingFormFields alone, so adding a
 * button to a display leaf still fails even though a form now exists on the page.
 *
 * PURE — no hooks, no effects, no server imports. All state and submission are the client island's
 * (payer-alias-ruling-form.tsx); this renders markup from props so the hermetic suite can assert
 * labelling, the relationship↔canonical pairing, and the absence of a bulk control.
 * ══════════════════════════════════════════════════════════════════════════════════════════════════ */

/** Human labels for the six relationships. `tpa` and `employer_self_funded` have no rows today and
 *  are offered anyway — forcing a genuine TPA into `same_payer` writes a permanent falsehood into a
 *  row whose whole purpose is attributed truth (ruled 2026-09-05). */
export const RELATIONSHIP_LABELS: Record<PayerAliasRelationship, string> = {
  same_payer: 'Same payer',
  carve_out: 'Carve-out',
  tpa: 'TPA (administers for another)',
  employer_self_funded: 'Employer, self-funded',
  program_label: 'Program label (no payer)',
  unmapped: 'Not a resolvable payer',
};

export interface RulingFormState {
  action: RulingAction;
  relationship: PayerAliasRelationship;
  canonicalPayerId: string;
  reviewNote: string;
}

/**
 * The state a ruling form OPENS on for a given queue row — pure, so it is testable without a router.
 *
 * ⚠️ THE RELATIONSHIP IS THE ROW'S OWN PROPOSAL, NOT A CONSTANT (Qodo #335 finding 1). The form used
 * to hard-code `same_payer` while the page passed only the proposed canonical, so a `carve_out`
 * proposal confirmed as `same_payer` for any reviewer who accepted the pre-selected payer without
 * touching the relationship control. Both halves of the proposal have to survive to the form or the
 * pre-selection is a trap.
 */
export function initialRulingState(
  proposedRelationship: string,
  proposedCanonicalId: string | null,
): RulingFormState {
  return {
    action: 'confirm',
    relationship: defaultRulingRelationship(proposedRelationship),
    canonicalPayerId: proposedCanonicalId ?? '',
    reviewNote: '',
  };
}

export function RulingFormFields({
  alias,
  state,
  identities,
  pending,
  error,
  errorField,
  onChange,
  idPrefix,
}: {
  alias: string;
  state: RulingFormState;
  /** Active identities only — the definer rejects a retired canonical, so offering one is a dead end. */
  identities: ReadonlyArray<{ canonical_payer_id: string; display_name: string; entity_kind: string | null }>;
  pending: boolean;
  error: string | null;
  errorField: string | null;
  onChange: (patch: Partial<RulingFormState>) => void;
  /** Namespaces every id so N cards on a page cannot collide their <label for>. */
  idPrefix: string;
}): ReactNode {
  const isDefer = state.action === 'defer';
  const needsCanonical = !isDefer && RELATIONSHIP_REQUIRES_CANONICAL[state.relationship];
  const id = (part: string) => `${idPrefix}-${part}`;

  return (
    <div className="mt-3 border-t border-line pt-3">
      {/* The alias travels in a hidden field so the island submits the exact stored PK value. It is
          NOT a link, NOT a route param, and NOT in any data-* a link consumes — alias_norm must
          never reach a URL. */}
      <input type="hidden" name="aliasNorm" value={alias} readOnly />

      <fieldset className="flex flex-wrap items-center gap-3" disabled={pending}>
        <legend className="sr-only">Ruling for {alias}</legend>

        <div>
          <label htmlFor={id('action')} className="mr-2 text-xs font-medium text-ink600">
            Action
          </label>
          <select
            id={id('action')}
            name="action"
            value={state.action}
            onChange={(e) => onChange({ action: e.target.value as RulingAction })}
            className="rounded-md border border-line bg-surface px-2 py-1 text-sm text-ink900"
          >
            <option value="confirm">Confirm</option>
            <option value="defer">Defer with note</option>
          </select>
        </div>

        {!isDefer ? (
          <div>
            <label htmlFor={id('relationship')} className="mr-2 text-xs font-medium text-ink600">
              Relationship
            </label>
            <select
              id={id('relationship')}
              name="relationship"
              value={state.relationship}
              onChange={(e) => onChange({ relationship: e.target.value as PayerAliasRelationship })}
              className="rounded-md border border-line bg-surface px-2 py-1 text-sm text-ink900"
            >
              {PAYER_ALIAS_RELATIONSHIPS.map((r) => (
                <option key={r} value={r}>
                  {RELATIONSHIP_LABELS[r]}
                </option>
              ))}
            </select>
          </div>
        ) : null}

        {/* The canonical picker is OMITTED, not disabled, when the relationship forbids one. The
            CHECK payer_alias_map_relationship_canonical rejects a canonical on program_label /
            unmapped, so a greyed-out control holding a stale value is a submission waiting to fail. */}
        {needsCanonical ? (
          <div>
            <label htmlFor={id('canonical')} className="mr-2 text-xs font-medium text-ink600">
              Canonical payer
            </label>
            <select
              id={id('canonical')}
              name="canonicalPayerId"
              value={state.canonicalPayerId}
              onChange={(e) => onChange({ canonicalPayerId: e.target.value })}
              className="rounded-md border border-line bg-surface px-2 py-1 text-sm text-ink900"
            >
              <option value="">Choose…</option>
              {identities.map((pi) => (
                <option key={pi.canonical_payer_id} value={pi.canonical_payer_id}>
                  {pi.display_name}
                  {pi.entity_kind ? ` · ${pi.entity_kind}` : ''}
                </option>
              ))}
            </select>
          </div>
        ) : null}
      </fieldset>

      <div className="mt-2">
        <label htmlFor={id('note')} className="text-xs font-medium text-ink600">
          Note{isDefer ? ' (required)' : ' (optional)'}
        </label>
        <textarea
          id={id('note')}
          name="reviewNote"
          value={state.reviewNote}
          disabled={pending}
          maxLength={500}
          rows={2}
          required={isDefer}
          onChange={(e) => onChange({ reviewNote: e.target.value })}
          placeholder={isDefer ? 'What did you find? A defer without a note records nothing.' : ''}
          className="mt-1 w-full rounded-md border border-line bg-surface px-2 py-1 text-sm text-ink900"
        />
      </div>

      {/* role=alert so a rejection is announced, and aria-describedby wiring is on the control the
          server blamed — a message that only appears visually is invisible to a screen reader. */}
      {error !== null ? (
        <p role="alert" className="mt-2 text-xs text-status-danger">
          {error}
          {errorField !== null ? <span className="sr-only"> (field: {errorField})</span> : null}
        </p>
      ) : null}

      <div className="mt-2 flex items-center gap-2">
        <button
          type="submit"
          disabled={pending}
          className="rounded-md bg-teal700 px-3 py-1.5 text-sm font-medium text-surface disabled:opacity-60"
        >
          {pending ? 'Saving…' : isDefer ? 'Save note' : 'Confirm ruling'}
        </button>
        <span className="text-xs text-ink400">One alias at a time — there is no bulk confirm.</span>
      </div>
    </div>
  );
}
