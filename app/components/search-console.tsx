'use client';

/**
 * The search console. A natural-language question goes to the agent Server Action
 * (server-side; the browser never holds the API secret), which returns a chosen
 * tool + non-PHI summary. "Show underlying rows" then calls the results Server
 * Action with the opaque query_id to fetch PHI rows.
 *
 * Quick-question buttons drive the same path: most auto-run; the patient-history
 * one only populates the prompt (the user types the last name) since client_history
 * needs a real name. client_history rows are only fetchable after the user
 * re-supplies the patient identity (verified server-side); a fail-closed empty
 * result is presented as "no match on the supplied identity," not "no such patient."
 */
import { useRef, useState } from 'react';

import { IdentityForm } from '@/components/identity-form';
import { QuickQuestions, type QuickQuestion } from '@/components/quick-questions';
import { ResultsTable } from '@/components/results-table';
import { SummaryView } from '@/components/summary-view';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import {
  fetchRows,
  runSearch,
  type AgentActionResult,
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

export function SearchConsole() {
  const [question, setQuestion] = useState('');
  const [searching, setSearching] = useState(false);
  const [agent, setAgent] = useState<AgentActionResult | null>(null);

  const [rowsLoading, setRowsLoading] = useState(false);
  const [rowsResult, setRowsResult] = useState<ResultsActionResult | null>(null);

  const inputRef = useRef<HTMLInputElement>(null);

  async function runQuestion(q: string) {
    if (q.trim() === '' || searching) return;
    setSearching(true);
    setAgent(null);
    setRowsResult(null);
    try {
      setAgent(await runSearch(q));
    } finally {
      setSearching(false);
    }
  }

  function onQuickSelect(item: QuickQuestion) {
    setQuestion(item.question);
    if (item.autoRun) {
      void runQuestion(item.question);
    } else {
      // Populate only — focus the prompt so the user can finish it (e.g. add a name).
      requestAnimationFrame(() => {
        const el = inputRef.current;
        if (el) {
          el.focus();
          el.setSelectionRange(item.question.length, item.question.length);
        }
      });
    }
  }

  async function doFetchRows(identity?: ResultsIdentity) {
    if (!agent || !agent.ok || rowsLoading) return;
    setRowsLoading(true);
    setRowsResult(null);
    try {
      setRowsResult(await fetchRows(agent.query_id, identity));
    } finally {
      setRowsLoading(false);
    }
  }

  const isClientHistory = agent?.ok && agent.tool_name === 'client_history';

  return (
    <div className="space-y-6">
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void runQuestion(question);
        }}
        className="flex gap-2"
      >
        <Input
          ref={inputRef}
          value={question}
          onChange={(e) => setQuestion(e.target.value)}
          placeholder="Ask about the claims data — e.g. “payer gaps for Beacon Carelon in 2025”"
          aria-label="Search question"
          disabled={searching}
        />
        <Button type="submit" disabled={searching || question.trim() === ''}>
          {searching ? 'Searching…' : 'Search'}
        </Button>
      </form>

      <QuickQuestions disabled={searching} onSelect={onQuickSelect} />

      {searching && <Notice tone="muted">Interpreting your question…</Notice>}

      {agent && !agent.ok && <Notice tone="error">{agent.error}</Notice>}

      {agent && agent.ok && (
        <div className="space-y-4">
          <SummaryView toolName={agent.tool_name} summary={agent.summary_stats} />

          <Card>
            <CardHeader>
              <CardTitle className="text-base">Underlying rows</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              {isClientHistory ? (
                <IdentityForm pending={rowsLoading} onSubmit={(id) => doFetchRows(id)} />
              ) : (
                <Button
                  variant="outline"
                  size="sm"
                  disabled={rowsLoading}
                  onClick={() => doFetchRows()}
                >
                  {rowsLoading ? 'Loading rows…' : 'Show underlying rows'}
                </Button>
              )}

              {rowsLoading && <Notice tone="muted">Loading rows…</Notice>}

              {rowsResult && !rowsResult.ok && <Notice tone="error">{rowsResult.error}</Notice>}

              {rowsResult && rowsResult.ok && rowsResult.rows.length > 0 && (
                <ResultsTable rows={rowsResult.rows} />
              )}

              {rowsResult && rowsResult.ok && rowsResult.rows.length === 0 && (
                <Notice tone="muted">
                  {isClientHistory
                    ? 'No rows matched the supplied identity. Double-check the last name and member ID — this does not necessarily mean the patient has no claims.'
                    : 'No underlying rows are available for this result (the query handle may have expired).'}
                </Notice>
              )}
            </CardContent>
          </Card>
        </div>
      )}
    </div>
  );
}
