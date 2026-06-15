'use client';

/**
 * The search console — a lightweight conversational transcript (Phase 7.6).
 *
 * Each turn is: a user message (the question, or a field-picker-derived search) →
 * an assistant block (non-PHI summary, a deterministic field-picker when the query
 * was too broad, or an error). Every completed OK turn keeps its OWN query_id, so
 * "show underlying rows" stays tied to that turn and goes through the existing
 * audited results path unchanged. The browser never holds the API secret.
 *
 * PHI discipline: the agent path is PHI-free by construction (summaries only). Row
 * reveal is per-turn via the opaque query_id (and, for client_history, identity
 * re-entry verified server-side). Nothing in the transcript — questions, summaries,
 * rows, or revealed values — is persisted to localStorage/sessionStorage/cookies.
 */
import { useEffect, useRef, useState } from 'react';

import { FieldPicker } from '@/components/field-picker';
import { IdentityForm } from '@/components/identity-form';
import { QuickQuestions, type QuickQuestion } from '@/components/quick-questions';
import { ResultsTable } from '@/components/results-table';
import { SummaryView } from '@/components/summary-view';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import {
  fetchRows,
  loadClaimFacets,
  runClaimSearch,
  runSearch,
  type AgentActionResult,
  type ClaimFacets,
  type ClaimFilter,
  type ResultsActionResult,
  type ResultsIdentity,
} from '@/lib/actions';

function Notice({ tone, children }: { tone: 'error' | 'muted'; children: React.ReactNode }) {
  const cls =
    tone === 'error'
      ? 'border-status-danger/30 bg-status-danger/10 text-status-danger'
      : 'border-teal200 bg-teal50/60 text-ink600';
  return <div className={`rounded-md border px-3 py-2 text-sm ${cls}`}>{children}</div>;
}

/** One conversational turn. `result === null` means the turn is still resolving. */
interface Turn {
  id: number;
  question: string;
  result: AgentActionResult | null;
  rowsLoading: boolean;
  rows: ResultsActionResult | null;
}

/** Render a chosen filter as a short, non-PHI human-readable label. */
function describeFilter(f: ClaimFilter): string {
  const parts: string[] = [];
  if (f.facility) parts.push(`facility ${f.facility}`);
  if (f.payer) parts.push(`payer ${f.payer}`);
  if (f.source_year) parts.push(`year ${f.source_year}`);
  if (f.date_from) parts.push(`from ${f.date_from}`);
  if (f.date_to) parts.push(`to ${f.date_to}`);
  if (f.hcpcs_code) parts.push(`HCPCS ${f.hcpcs_code}`);
  if (f.revenue_code) parts.push(`revenue ${f.revenue_code}`);
  return `Filtered claim search — ${parts.join(', ')}`;
}

export function SearchConsole() {
  const [question, setQuestion] = useState('');
  const [busy, setBusy] = useState(false);
  const [turns, setTurns] = useState<Turn[]>([]);
  const [facets, setFacets] = useState<ClaimFacets | null>(null);

  const nextId = useRef(1);
  const inputRef = useRef<HTMLInputElement>(null);

  // Load safe (non-PHI, cached) facet option lists once for the field-picker.
  useEffect(() => {
    let live = true;
    loadClaimFacets().then((r) => {
      if (live && r.ok) setFacets(r.data);
    });
    return () => {
      live = false;
    };
  }, []);

  function patchTurn(id: number, patch: Partial<Turn>) {
    setTurns((prev) => prev.map((t) => (t.id === id ? { ...t, ...patch } : t)));
  }

  /** Append a pending turn and resolve it with the supplied async runner. */
  async function addTurn(label: string, run: () => Promise<AgentActionResult>) {
    if (busy) return;
    const id = nextId.current++;
    setTurns((prev) => [...prev, { id, question: label, result: null, rowsLoading: false, rows: null }]);
    setBusy(true);
    try {
      const result = await run();
      patchTurn(id, { result });
    } catch {
      patchTurn(id, { result: { kind: 'error', error: 'The search could not be completed.' } });
    } finally {
      setBusy(false);
    }
  }

  async function askQuestion(q: string) {
    if (q.trim() === '') return;
    setQuestion('');
    await addTurn(q.trim(), () => runSearch(q.trim()));
  }

  async function submitPicker(filter: ClaimFilter) {
    await addTurn(describeFilter(filter), () => runClaimSearch(filter));
  }

  function onQuickSelect(item: QuickQuestion) {
    if (item.autoRun) {
      void askQuestion(item.question);
    } else {
      // Populate only — focus the prompt so the user can finish it (e.g. add a name).
      setQuestion(item.question);
      requestAnimationFrame(() => {
        const el = inputRef.current;
        if (el) {
          el.focus();
          el.setSelectionRange(item.question.length, item.question.length);
        }
      });
    }
  }

  async function showRows(turn: Turn, identity?: ResultsIdentity) {
    if (!turn.result || turn.result.kind !== 'ok' || turn.rowsLoading) return;
    patchTurn(turn.id, { rowsLoading: true, rows: null });
    try {
      const rows = await fetchRows(turn.result.query_id, identity);
      patchTurn(turn.id, { rows, rowsLoading: false });
    } catch {
      patchTurn(turn.id, { rows: { ok: false, error: 'The rows could not be loaded.' }, rowsLoading: false });
    }
  }

  return (
    <div className="space-y-6">
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void askQuestion(question);
        }}
        className="flex gap-2"
      >
        <Input
          ref={inputRef}
          value={question}
          onChange={(e) => setQuestion(e.target.value)}
          placeholder="Ask about the claims data — e.g. “payer gaps for Beacon Carelon in 2025”"
          aria-label="Search question"
          disabled={busy}
        />
        <Button type="submit" disabled={busy || question.trim() === ''}>
          {busy ? 'Searching…' : 'Search'}
        </Button>
      </form>

      {turns.length === 0 && <QuickQuestions disabled={busy} onSelect={onQuickSelect} />}

      {turns.length > 0 && (
        <div className="space-y-6">
          {turns.map((turn) => (
            <TurnView
              key={turn.id}
              turn={turn}
              facets={facets}
              onPickerSubmit={submitPicker}
              onShowRows={showRows}
            />
          ))}
        </div>
      )}

      {turns.length > 0 && <QuickQuestions disabled={busy} onSelect={onQuickSelect} />}
    </div>
  );
}

function TurnView({
  turn,
  facets,
  onPickerSubmit,
  onShowRows,
}: {
  turn: Turn;
  facets: ClaimFacets | null;
  onPickerSubmit: (filter: ClaimFilter) => void;
  onShowRows: (turn: Turn, identity?: ResultsIdentity) => void;
}) {
  return (
    <div className="space-y-3">
      {/* User message */}
      <div className="flex justify-end">
        <div className="max-w-[85%] rounded-lg rounded-br-sm bg-teal700 px-3 py-2 text-sm text-white">
          {turn.question}
        </div>
      </div>

      {/* Assistant block */}
      <div className="space-y-3">
        {turn.result === null && <Notice tone="muted">Interpreting your question…</Notice>}

        {turn.result?.kind === 'error' && <Notice tone="error">{turn.result.error}</Notice>}

        {turn.result?.kind === 'needs_input' && (
          <FieldPicker
            missing={turn.result.missing}
            facets={facets}
            pending={false}
            onSubmit={onPickerSubmit}
          />
        )}

        {turn.result?.kind === 'ok' && (
          <>
            <SummaryView toolName={turn.result.tool_name} summary={turn.result.summary_stats} />
            <RowsCard turn={turn} onShowRows={onShowRows} />
          </>
        )}
      </div>
    </div>
  );
}

function RowsCard({
  turn,
  onShowRows,
}: {
  turn: Turn;
  onShowRows: (turn: Turn, identity?: ResultsIdentity) => void;
}) {
  const isClientHistory = turn.result?.kind === 'ok' && turn.result.tool_name === 'client_history';
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Underlying rows</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        {isClientHistory ? (
          <IdentityForm pending={turn.rowsLoading} onSubmit={(id) => onShowRows(turn, id)} />
        ) : (
          <Button variant="outline" size="sm" disabled={turn.rowsLoading} onClick={() => onShowRows(turn)}>
            {turn.rowsLoading ? 'Loading rows…' : 'Show underlying rows'}
          </Button>
        )}

        {turn.rows && !turn.rows.ok && <Notice tone="error">{turn.rows.error}</Notice>}

        {turn.rows && turn.rows.ok && turn.rows.rows.length > 0 && <ResultsTable rows={turn.rows.rows} />}

        {turn.rows && turn.rows.ok && turn.rows.rows.length === 0 && (
          <Notice tone="muted">
            {isClientHistory
              ? 'No rows matched the supplied identity. Double-check the last name and member ID — this does not necessarily mean the patient has no claims.'
              : 'No underlying rows are available for this result (the query handle may have expired).'}
          </Notice>
        )}
      </CardContent>
    </Card>
  );
}
