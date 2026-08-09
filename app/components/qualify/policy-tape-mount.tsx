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
import { useEffect, useMemo, useState } from 'react';
import { getQualifyPolicyTape } from '@/lib/qualify/board-actions';
import type { QualifyPolicyTapeItem, QualifyPolicyTapeResult } from '@/lib/qualify/board';
import { PolicyTapeSkeleton, PolicyTapeStrip } from './policy-tape';
import { TickerExplainer } from './ticker-explainer';
import { buildTapeAiInput } from '../../lib/qualify/tickerAiPayload';

export function PolicyTapeMount() {
  // null = still loading (skeleton); a result = decided.
  const [tape, setTape] = useState<QualifyPolicyTapeResult | null>(null);
  /** The card whose explanation is open, or null. Holding the ITEM (not its key) means the panel and
   *  the payload read the same object — a key would have to be looked up twice and could drift. */
  const [explaining, setExplaining] = useState<QualifyPolicyTapeItem | null>(null);

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
  return (
    <>
      <PolicyTapeStrip
        items={tape.items}
        asOf={tape.asOf}
        deltaDays={tape.deltaDays}
        onExplain={setExplaining}
        explainingKey={explaining ? `${explaining.token}-${explaining.payer}` : null}
      />
      {explaining ? (
        <TickerExplainerForItem item={explaining} deltaDays={tape.deltaDays} onClose={() => setExplaining(null)} />
      ) : null}
    </>
  );
}

/**
 * The payload memo lives in its OWN component, and that is a correctness requirement rather than
 * tidiness: `TickerExplainer` re-asks whenever its `input` identity changes, so building the object
 * inline in the parent would mint a fresh one on every parent render — every keystroke elsewhere on
 * the page would fire another audited, billed model call. Here the memo's only dependencies are the
 * item and the horizon, so the ask happens once per clicked card.
 *
 * `blind: false` is the honest value on this strip: the tape projects no dollar column at all (see
 * buildPolicyTapeQuery), so there are no amounts to withhold and the flag would only change the
 * model's phrasing about dollars it was never given. The server re-derives the real capability from
 * the principal regardless — this field is a hint, never the control.
 */
function TickerExplainerForItem({
  item,
  deltaDays,
  onClose,
}: {
  item: QualifyPolicyTapeItem;
  deltaDays: number;
  onClose: () => void;
}) {
  const input = useMemo(() => buildTapeAiInput(item, deltaDays, false), [item, deltaDays]);
  const handle = item.echo ?? item.prefix ?? `⋯${item.tokenTail.slice(-4)}`;
  const move = item.deltaPts > 0 ? `▲ +${item.deltaPts}` : item.deltaPts < 0 ? `▼ ${item.deltaPts}` : '◆ 0';
  return (
    <TickerExplainer
      title={`${handle} · ${item.payer}`}
      subtitle={`Rating ${item.ratingNow} · ${move} pts over ${deltaDays} days`}
      input={input}
      onClose={onClose}
    />
  );
}
