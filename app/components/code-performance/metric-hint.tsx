'use client';

/**
 * MetricHint — the accessible hover/focus disclosure that lets this surface carry its caveats
 * without spending vertical space on them.
 *
 * ── WHY THIS EXISTS ──────────────────────────────────────────────────────────────────────────────
 * Every metric here needs a caveat ("not clamped — over 100% is exposure", "charge → LAST posting,
 * not first dollar") and those caveats are load-bearing: read the number without them and you draw
 * the wrong conclusion. They used to sit as `sub` prose inside each KPI tile, which cost the page
 * two things at once — the grid row takes the height of its TALLEST tile, so one four-line caveat
 * inflated five neighbours into tall empty boxes, and the same sentence was already repeated in the
 * table header below.
 *
 * ⚠️ THE CAVEAT IS IN THE DOM WHETHER OR NOT IT IS OPEN, AND THAT IS DELIBERATE. `hidden` toggles
 * VISIBILITY, not presence: a closed hint still serialises its children, so the text is available to
 * find-in-page, to a static render, and to the test that asserts a suppression reason reaches the
 * markup. This is a disclosure, never a containment boundary — nothing may be put behind it that
 * must not ship to the client (the dollar-gating rule in pr_compliance_checklist.yaml is about
 * values that must be omitted SERVER-side, and none of those are here).
 *
 * ⚠️ IT OPENS ON FOCUS AS WELL AS HOVER, AND THE TWO ARE SEPARATE STATE (Qodo #350 finding 4).
 * The first version kept ONE boolean and hung the handlers on the BUTTON, which broke the component
 * in both input modes at once:
 *   · the panel is an absolutely-positioned SIBLING, so the button's `mouseleave` fired the moment
 *     the pointer travelled toward the panel — it could never be reached, read, or text-selected;
 *   · `focus` set open and `click` TOGGLED the same boolean, so a keyboard Enter/Space (which fires
 *     focus first, then click) opened and immediately closed it.
 * The caveats this component holds are the ones the KPI tiles gave up their height for, so an
 * unreachable panel does not relocate that information — it deletes it.
 *
 * Now: `hover` and `focused` are tracked independently and the panel is open while EITHER holds, so
 * a pointer moving from the button into the panel keeps it open (the panel is inside the wrapper the
 * handlers sit on, so no `mouseleave` fires) and a blur cannot close a panel the pointer is still in.
 * Click FORCES open rather than toggling — on a real click focus has already opened it, so a toggle
 * is guaranteed to close it. Escape sets `dismissed`, which leaving resets so the next hover re-arms.
 *
 * NOT a `title=` attribute: those are unreachable on touch, unstyleable, and announced
 * inconsistently. Tokens only, no literal hex (the source sweep in code-performance-render.test.tsx
 * fails on one).
 */
import { useId, useState, type ReactNode } from 'react';
import { Info } from 'lucide-react';

export function MetricHint({
  label,
  children,
  align = 'left',
}: {
  /** Names the metric in the button's accessible name — "About paid of allowed". */
  label: string;
  children: ReactNode;
  /** Which edge the panel hangs from, so a hint on a right-aligned column stays on screen. */
  align?: 'left' | 'right';
}) {
  const [hover, setHover] = useState(false);
  const [focused, setFocused] = useState(false);
  const [dismissed, setDismissed] = useState(false);
  const id = useId();
  const open = (hover || focused) && !dismissed;
  return (
    // ⚠️ THE HANDLERS BELONG ON THE WRAPPER, NOT THE BUTTON, AND THE PANEL IS INSIDE IT. That is what
    // lets the pointer travel from the button into the panel without a mouseleave closing it.
    // React's onFocus/onBlur map to focusin/focusout, so they bubble from the button and need no
    // capture phase.
    <span
      className="relative inline-flex align-middle"
      onMouseEnter={() => {
        setHover(true);
        setDismissed(false);
      }}
      onMouseLeave={() => {
        setHover(false);
        setDismissed(false);
      }}
      onFocus={() => setFocused(true)}
      onBlur={() => {
        setFocused(false);
        setDismissed(false);
      }}
    >
      <button
        type="button"
        aria-label={`About ${label}`}
        aria-expanded={open}
        aria-describedby={id}
        // Forces open instead of toggling: focus fires first on a real click, so a toggle here
        // would close what the focus just opened. Escape and leaving are the ways out.
        onClick={() => setDismissed(false)}
        onKeyDown={(e) => {
          if (e.key === 'Escape') setDismissed(true);
        }}
        className="inline-flex h-6 w-6 items-center justify-center rounded-full text-ink400 transition-colors hover:bg-teal50 hover:text-teal700 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-teal500"
      >
        <Info aria-hidden className="h-3.5 w-3.5" />
      </button>
      {/* role=note, not tooltip: the panel is a persistent description the button points at with
          aria-describedby, and it stays open while hovered or focused — role=tooltip promises
          transient hover semantics this does not have. */}
      <span
        id={id}
        role="note"
        hidden={!open}
        className={[
          'absolute top-7 z-30 w-64 rounded-lg border border-line bg-surface p-2.5 text-left text-[11px] font-normal normal-case leading-snug tracking-normal text-ink600 shadow-ths-lg',
          align === 'right' ? 'right-0' : 'left-0',
        ].join(' ')}
      >
        {children}
      </span>
    </span>
  );
}
