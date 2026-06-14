'use client';

/**
 * Renders the PHI rows from /api/results. PHI columns (patient identifiers) are
 * MASKED by default and revealed per-row on an explicit click (gate 2) — the
 * value is in the DOM only once the row is revealed. Columns are taken from the
 * row keys, so each function's allowlist (and the a_/b_ paired readmission
 * columns) renders as returned, never SELECT *.
 *
 * These rows are PHI: they live in component state for the session only — never
 * persisted to localStorage, never sent anywhere else, never logged.
 */
import { useState } from 'react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { displayCell, isPhiColumn } from '@/lib/phi';

function columnLabel(column: string): string {
  return column.replace(/_/g, ' ');
}

export function ResultsTable({ rows }: { rows: Record<string, unknown>[] }) {
  // Reveal state is keyed by row index; resets whenever a new fetch replaces rows.
  const [revealed, setRevealed] = useState<Set<number>>(() => new Set());

  if (rows.length === 0) {
    return null; // empty state handled by the caller (may be a fail-closed non-match)
  }

  const columns = Object.keys(rows[0]);
  const hasPhi = columns.some(isPhiColumn);

  function toggle(index: number) {
    setRevealed((prev) => {
      const next = new Set(prev);
      if (next.has(index)) next.delete(index);
      else next.add(index);
      return next;
    });
  }

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <div className="text-sm text-muted-foreground">{rows.length.toLocaleString('en-US')} rows</div>
        {hasPhi && (
          <Badge variant="outline" className="gap-1 text-xs">
            PHI masked — reveal per row
          </Badge>
        )}
      </div>
      <div className="rounded-md border">
        <Table>
          <TableHeader>
            <TableRow>
              {hasPhi && <TableHead className="w-[1%]" />}
              {columns.map((c) => (
                <TableHead key={c} className="capitalize">
                  {columnLabel(c)}
                  {isPhiColumn(c) && <span className="ml-1 text-[10px] text-muted-foreground">PHI</span>}
                </TableHead>
              ))}
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((row, i) => {
              const isRevealed = revealed.has(i);
              return (
                <TableRow key={i}>
                  {hasPhi && (
                    <TableCell>
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        className="h-7 px-2 text-xs"
                        aria-pressed={isRevealed}
                        onClick={() => toggle(i)}
                      >
                        {isRevealed ? 'Hide' : 'Reveal'}
                      </Button>
                    </TableCell>
                  )}
                  {columns.map((c) => (
                    <TableCell
                      key={c}
                      className={isPhiColumn(c) && !isRevealed ? 'text-muted-foreground' : undefined}
                    >
                      {displayCell(c, row[c], isRevealed)}
                    </TableCell>
                  ))}
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}
