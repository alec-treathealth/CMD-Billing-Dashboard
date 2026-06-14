'use client';

/**
 * Quick-question buttons grouped by audience. Each maps to a question that routes
 * cleanly to one existing agent tool — no new query tools. Most auto-run; the
 * patient-history one only POPULATES the prompt (the user types the last name)
 * because client_history needs a real name in the question, and the row fetch
 * still goes through the existing identity re-entry flow (no PHI stored).
 */
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';

export interface QuickQuestion {
  label: string;
  question: string;
  /** true → run immediately; false → populate the prompt and let the user finish it. */
  autoRun: boolean;
}

interface QuickGroup {
  audience: string;
  items: QuickQuestion[];
}

const GROUPS: QuickGroup[] = [
  {
    audience: 'Admissions',
    items: [
      // Populate-only: client_history needs the real last name typed in.
      {
        label: 'Patient claim history',
        question: 'show the claim history for the patient whose last name is ',
        autoRun: false,
      },
      // NOTE: a "Readmission candidates" button is intentionally omitted for now.
      // It routes correctly to readmission_candidates, but that full-population
      // self-join times out (>90s) even when date-scoped; re-add once the query
      // gets performance work (index / mandatory facility filter / statement timeout).
    ],
  },
  {
    audience: 'Billing',
    items: [
      { label: 'Payer collection gaps', question: 'show collection gaps by payer', autoRun: true },
      {
        label: 'Charges vs allowed vs paid',
        question:
          'show total charges, allowed amounts, paid amounts, and collection rate by payer',
        autoRun: true,
      },
      {
        label: 'High unpaid 2025 claims',
        question: 'search claims with date of service in 2025 ordered by highest unpaid balance',
        autoRun: true,
      },
    ],
  },
  {
    audience: 'Owner / operator',
    items: [
      { label: 'Payer claim volume', question: 'distribution of claim counts by payer', autoRun: true },
    ],
  },
];

export function QuickQuestions({
  disabled,
  onSelect,
}: {
  disabled: boolean;
  onSelect: (q: QuickQuestion) => void;
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Common questions</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        {GROUPS.map((group) => (
          <div key={group.audience}>
            <div className="mb-1.5 text-xs font-medium uppercase tracking-wide text-muted-foreground">
              {group.audience}
            </div>
            <div className="flex flex-wrap gap-2">
              {group.items.map((item) => (
                <Button
                  key={item.label}
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={disabled}
                  onClick={() => onSelect(item)}
                  title={item.autoRun ? item.question : 'Fills the prompt — add the last name, then Search'}
                >
                  {item.label}
                </Button>
              ))}
            </div>
          </div>
        ))}
      </CardContent>
    </Card>
  );
}
