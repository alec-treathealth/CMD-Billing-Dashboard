'use client';

/**
 * Client shell for the staged v3 flow — owns the state, the motion, and the PHI discipline.
 *
 * ── WHERE THE TYPED IDENTIFIER LIVES ────────────────────────────────────────────────────────────
 * In `termRef` — JS memory only (the IdentityForm discipline). It is captured from the identify
 * form's FormData at dispatch and INJECTED into every later submission the same way, so it is never
 * rendered into the DOM as a hidden field, never in a URL, never persisted. What renders is
 * `handle.echo`, prefix-safe by construction ('' for a full member id). This is also what lets a
 * full-member-id search survive the plan-pick round trip: the earlier S1/S2 forms round-tripped the
 * EMPTY echo as the term, which re-resolved a full-id search as 'empty' — carrying the term in the
 * ref instead of the DOM fixes that without ever writing the id anywhere readable.
 *
 * ── STAGE MACHINE ───────────────────────────────────────────────────────────────────────────────
 * `deriveStage` is pure (resolution × payerPick × picked). The shell adds one escape hatch —
 * `backTo`, set by the receipt's Change buttons — and clears client choices when the user goes
 * back, so a stale carrier pick can never scope a new plan pick (the payer-override stale-read
 * class of bug, PR #124's lesson, applied here by construction).
 *
 * ── MOTION ──────────────────────────────────────────────────────────────────────────────────────
 * GSAP, the requested idiom: the incoming stage slides up 14px/220ms ease-out; tiles stagger
 * min(index,3)×60ms (capped — a 186-plan list must not cascade forever). One easing. Disabled
 * entirely under prefers-reduced-motion. Motion narrates progression; it never gates input.
 */
import { useActionState, useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import gsap from 'gsap';
import { resolveCoverageAction } from '../../../lib/qualify/v3-actions';
// V3_INITIAL_STATE comes from a PLAIN module, never the 'use server' one: a non-function export
// there is registered as a Server Action and 500s every action on the page (see v3FlowState.ts).
import { V3_INITIAL_STATE } from '../../../lib/qualify/v3FlowState';
import { getQualifySnapshot } from '../../../lib/qualify/actions';
import type { QualifySnapshot, QualifyTrailingDays } from '../../../lib/qualify/contract';
import { QualifyAiPanel } from '../qualify-ai-panel';
import { deriveStage, ResolutionStages, type FlowStage } from './resolution-flow';

export function ResolutionFlowClient({
  viewerHasAmountsCapability,
}: {
  viewerHasAmountsCapability: boolean;
}): React.ReactElement {
  const [state, formAction, isPending] = useActionState(resolveCoverageAction, V3_INITIAL_STATE);

  // The raw term — JS memory only. See the header block before moving this anywhere.
  const termRef = useRef<string>('');

  const [payerPick, setPayerPick] = useState<string | null>(null);
  const [picked, setPicked] = useState(false);
  const [planFilter, setPlanFilter] = useState('');
  const [autoAsk, setAutoAsk] = useState(false);
  const [backTo, setBackTo] = useState<FlowStage | null>(null);
  const [snapshot, setSnapshot] = useState<QualifySnapshot | null>(null);
  const [snapshotError, setSnapshotError] = useState<string | null>(null);
  const [payerOverride, setPayerOverride] = useState<string | null>(null);
  const [windowDays, setWindowDays] = useState<QualifyTrailingDays | null>(null);

  /** A new identify submit invalidates every downstream choice — clear them BEFORE dispatching. */
  const identifyAction = useCallback(
    (fd: FormData) => {
      const term = fd.get('term');
      termRef.current = typeof term === 'string' ? term : '';
      setPayerPick(null);
      setPicked(false);
      setPlanFilter('');
      setAutoAsk(false);
      setBackTo(null);
      setSnapshot(null);
      setSnapshotError(null);
      setPayerOverride(null);
      setWindowDays(null);
      formAction(fd);
    },
    [formAction],
  );

  /** A plan pick: inject the held term (never from the DOM), mark picked, dispatch. */
  const planAction = useCallback(
    (fd: FormData) => {
      fd.set('term', termRef.current);
      setPicked(true);
      setBackTo(null);
      setSnapshot(null);
      setSnapshotError(null);
      formAction(fd);
    },
    [formAction],
  );

  const onChange = useCallback((target: 'identify' | 'payer' | 'plan') => {
    // Going back CLEARS what was decided at and after that stage — a kept-but-hidden choice is how
    // one client's ranking ends up scoped to another's payer.
    setSnapshot(null);
    setSnapshotError(null);
    setAutoAsk(false);
    setPayerOverride(null);
    setWindowDays(null);
    setPicked(false);
    if (target !== 'plan') setPayerPick(null);
    setPlanFilter('');
    setBackTo(target);
  }, []);

  const derived = deriveStage({ resolution: state.resolution, payerPick, picked });
  // The receipt's Change can only step BACKWARD from what is derivable; any submit clears it.
  const stage: FlowStage = backTo ?? derived;

  // ── Snapshot for the answer stage — the hardened v2 data path under the new UI ────────────────
  const predicateId = state.resolution?.predicateId ?? null;
  useEffect(() => {
    if (stage !== 'answer' || predicateId === null || isPending) return;
    const term = termRef.current;
    if (term === '') return; // nothing held (e.g. hot-reload mid-flow) — the stage shows its own empty state
    let alive = true;
    setSnapshotError(null);
    getQualifySnapshot({
      query: term,
      window: { kind: 'trailing', days: windowDays ?? 90 },
      auto: windowDays === null,
      ...(payerOverride !== null ? { payerOverride } : {}),
    })
      .then((s) => {
        if (alive) setSnapshot(s);
      })
      .catch(() => {
        if (alive) {
          setSnapshot(null);
          setSnapshotError('failed');
        }
      });
    return () => {
      alive = false;
    };
  }, [stage, predicateId, isPending, payerOverride, windowDays]);

  // ── Motion ─────────────────────────────────────────────────────────────────────────────────────
  const stageRef = useRef<HTMLDivElement | null>(null);
  useLayoutEffect(() => {
    const el = stageRef.current;
    if (!el || window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    const ctx = gsap.context(() => {
      gsap.fromTo(el, { autoAlpha: 0, y: 14 }, { autoAlpha: 1, y: 0, duration: 0.22, ease: 'power2.out' });
      const tiles = el.querySelectorAll('[data-v3-tile]');
      if (tiles.length > 0) {
        gsap.fromTo(
          tiles,
          { autoAlpha: 0, y: 10 },
          {
            autoAlpha: 1,
            y: 0,
            duration: 0.15,
            ease: 'power2.out',
            delay: 0.08,
            stagger: (i: number) => Math.min(i, 3) * 0.06,
          },
        );
      }
    }, el);
    return () => ctx.revert();
  }, [stage]);

  return (
    <div ref={stageRef}>
      <ResolutionStages
        stage={stage}
        resolution={state.resolution}
        reason={state.reason}
        echo={state.echo}
        denied={state.denied}
        pending={isPending}
        payerPick={payerPick}
        planFilter={planFilter}
        identifyAction={identifyAction}
        planAction={planAction}
        onPickPayer={(p) => {
          setPayerPick(p);
          setBackTo(null);
        }}
        onPlanFilter={setPlanFilter}
        onAskAi={() => setAutoAsk(true)}
        onChange={onChange}
        answer={
          state.resolution
            ? {
                snapshot,
                snapshotError,
                aiPanel: snapshot ? (
                  <QualifyAiPanel snapshot={snapshot} blind={!viewerHasAmountsCapability} autoAsk={autoAsk} />
                ) : null,
                pending: isPending,
                payerOverride,
                onPayerOverride: (label) => {
                  setSnapshot(null);
                  setPayerOverride(label);
                },
                windowDays,
                onWindowDays: (d) => {
                  setSnapshot(null);
                  setWindowDays(d);
                },
              }
            : null
        }
      />
    </div>
  );
}
