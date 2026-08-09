'use client';

/**
 * The tape's own mount — fetch-on-mount, skeleton, then the strip.
 *
 * SEPARATE FROM THE STRIP so the strip stays pure and render-testable (no effects, no server
 * action), which is the split heating-ticker.tsx uses: the shell fetches, the memo'd strip renders.
 *
 * MOUNTED FROM page.tsx RATHER THAN FROM THE v3 SHELL, on purpose. resolution-flow-client.tsx is
 * the search rewrite's file and is under active development in another branch; threading one more
 * fetch + one more state field through it would create a merge conflict for a strip that needs
 * nothing from the flow's state. This component owns its own load and renders above the flow.
 *
 * FAIL-SOFT TO NOTHING. The tape is orientation, never the answer — so an unapplied migration
 * (`available: false`), a failed read (`ok: false`), or simply no policy having moved all render
 * as ABSENT rather than as an error or an empty bar. A strip that says nothing occupies no space.
 */
import { useEffect, useState } from 'react';
import { getQualifyPolicyTape } from '@/lib/qualify/board-actions';
import type { QualifyPolicyTapeResult } from '@/lib/qualify/board';
import { PolicyTapeSkeleton, PolicyTapeStrip } from './policy-tape';

export function PolicyTapeMount() {
  // null = still loading (skeleton); a result = decided.
  const [tape, setTape] = useState<QualifyPolicyTapeResult | null>(null);

  useEffect(() => {
    let alive = true;
    getQualifyPolicyTape()
      .then((res) => {
        if (!alive) return;
        // `{ ok: false }` is the action's fail-closed union — collapse it to "nothing to show"
        // rather than surfacing a read failure on a strip nobody asked for.
        setTape(res.ok ? res.tape : { available: false, asOf: null, deltaDays: 0, items: [] });
      })
      .catch(() => {
        if (alive) setTape({ available: false, asOf: null, deltaDays: 0, items: [] });
      });
    return () => {
      alive = false;
    };
  }, []);

  if (tape === null) return <PolicyTapeSkeleton />;
  if (!tape.available || tape.items.length === 0) return null;
  return <PolicyTapeStrip items={tape.items} asOf={tape.asOf} deltaDays={tape.deltaDays} />;
}
