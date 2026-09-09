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
 * ⚠️ IT OPENS ON FOCUS, NOT ONLY ON HOVER. A hover-only affordance is invisible to a keyboard and to
 * touch (WCAG 2.1.1). This is a real <button>, so it is tabbable, it toggles on click for touch, and
 * Escape closes it (1.4.13). `aria-describedby` points the button at the panel, so a screen reader
 * reads the caveat as the button's description rather than as orphaned text.
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
  const [open, setOpen] = useState(false);
  const id = useId();
  return (
    <span className="relative inline-flex align-middle">
      <button
        type="button"
        aria-label={`About ${label}`}
        aria-expanded={open}
        aria-describedby={id}
        onMouseEnter={() => setOpen(true)}
        onMouseLeave={() => setOpen(false)}
        onFocus={() => setOpen(true)}
        onBlur={() => setOpen(false)}
        onClick={() => setOpen((o) => !o)}
        onKeyDown={(e) => {
          if (e.key === 'Escape') setOpen(false);
        }}
        className="inline-flex h-6 w-6 items-center justify-center rounded-full text-ink400 transition-colors hover:bg-teal50 hover:text-teal700 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-teal500"
      >
        <Info aria-hidden className="h-3.5 w-3.5" />
      </button>
      {/* role=note, not tooltip: the panel is a persistent description the button points at with
          aria-describedby, and it stays open on click for touch — role=tooltip promises transient
          hover semantics this does not have. */}
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
