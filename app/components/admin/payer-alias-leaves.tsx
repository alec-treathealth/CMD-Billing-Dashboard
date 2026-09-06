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
 * ⚠️ `alias_norm` CAN BE AN EMPLOYER NAME — `employer_self_funded` is a real relationship, so a
 * self-funded employer's own name is a legitimate alias string. It is rendered (ruled non-PHI for
 * display to an authenticated principal, 2026-08-14) but it must never reach a URL. NOTHING in this
 * file puts `alias_norm` into an href, a form action, or a data attribute that a link consumes:
 * `vocabTabHref` and `pageHref` build from the vocabulary enum and an integer only.
 *
 * READ-ONLY. Artifact 2 has no controls that mutate — no confirm button, no relationship picker.
 * Those arrive with the write chain in Artifact 3.
 */
import type { ReactNode } from 'react';
import {
  PAYER_ALIAS_VOCABULARIES,
  type PayerAliasNeighbourRow,
  type PayerAliasQueueRow,
  type PayerAliasSiblingRow,
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

/* ── The card ─────────────────────────────────────────────────────────────────────────────────── */

export function QueueCard({
  row,
  siblings,
  neighbours,
}: {
  row: PayerAliasQueueRow;
  siblings: readonly PayerAliasSiblingRow[];
  neighbours: readonly PayerAliasNeighbourRow[];
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
      <SiblingList siblings={siblings} />
      <NeighbourList neighbours={neighbours} />
    </li>
  );
}

export function QueueList({
  rows,
  siblings,
  neighbours,
}: {
  rows: readonly PayerAliasQueueRow[];
  siblings: Record<string, PayerAliasSiblingRow[]>;
  neighbours: Record<string, PayerAliasNeighbourRow[]>;
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
  const first = total === 0 ? 0 : (page - 1) * pageSize + 1;
  const last = Math.min(page * pageSize, total);
  const linkCls =
    'rounded-md border border-line px-3 py-1.5 text-sm text-ink900 hover:bg-ground';
  const deadCls = 'rounded-md border border-line px-3 py-1.5 text-sm text-ink400';
  return (
    <nav aria-label="Queue pages" className="mt-4 flex items-center justify-between gap-3">
      <p className="text-xs tabular-nums text-ink600">
        {total === 0 ? 'No unruled rows' : `Showing ${first}–${last} of ${total} unruled`}
      </p>
      <div className="flex gap-2">
        {page > 1 ? (
          <a href={pageHref(vocabulary, page - 1)} className={linkCls} rel="prev">
            Previous
          </a>
        ) : (
          <span className={deadCls} aria-disabled="true">
            Previous
          </span>
        )}
        {hasMore ? (
          <a href={pageHref(vocabulary, page + 1)} className={linkCls} rel="next">
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
