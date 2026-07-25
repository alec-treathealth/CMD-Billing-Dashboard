'use client';

/**
 * Qualify LANDING HERO — the animated brand atmosphere that fills the resolved-subject area on a FRESH
 * landing (before any search). Purely DECORATIVE + the search guidance: no data, no PHI, no props. The
 * subject / facilities / Recent-Claims grid replaces it the moment a search or a Heating-Up tap resolves
 * a payer.
 *
 * Aesthetic (warm-clinical teal, matching the redesign): slow-drifting radial glows for atmosphere, a
 * faint payer↔facility↔member "constellation" whose links flow and nodes breathe (the product's own
 * metaphor — resolving a lead's connections), and a breathing brand monogram over a Fraunces prompt.
 * All motion is CSS-only (see the `.q-hero-*` block in globals.css) and collapses to static under the
 * global prefers-reduced-motion reset. Decorative layers are aria-hidden; the section carries the label.
 *
 * NOTE: the monogram is an abstract on-brand mark — drop a real logo SVG (TreatHealth / BXR / Indigo)
 * in place of `<HeroMark/>` if you'd rather show actual logos.
 */

/** Faint hub-and-spoke network behind the prompt — evokes payer↔facility↔member links resolving. */
const NODES: { x: number; y: number; kind: 'hub' | 'node' | 'warm'; d: number }[] = [
  { x: 360, y: 160, kind: 'hub', d: 0 },
  { x: 150, y: 78, kind: 'node', d: 0.6 },
  { x: 596, y: 92, kind: 'node', d: 1.2 },
  { x: 628, y: 236, kind: 'node', d: 0.3 },
  { x: 120, y: 242, kind: 'node', d: 1.6 },
  { x: 360, y: 44, kind: 'warm', d: 0.9 },
  { x: 470, y: 262, kind: 'node', d: 2.1 },
];
const LINKS: [number, number][] = [
  [0, 1], [0, 2], [0, 3], [0, 4], [0, 5], [0, 6], // hub → each
  [1, 5], [2, 3], [4, 6], // a few cross-links for mesh feel
];

function HeroMark() {
  return (
    <span
      className="q-hero-mark relative inline-flex h-16 w-16 items-center justify-center rounded-2xl"
      style={{ background: 'linear-gradient(135deg, #0E3A3A 0%, #135E5A 60%, #1C8B82 100%)' }}
      aria-hidden
    >
      {/* abstract "resolve" glyph — a node with an orbiting spark; swap for a real logo SVG if desired */}
      <svg width="34" height="34" viewBox="0 0 34 34" fill="none">
        <circle cx="17" cy="17" r="6.5" fill="#EAF4F2" />
        <circle cx="17" cy="17" r="11" stroke="#B7DAD5" strokeOpacity="0.6" strokeWidth="1.5" fill="none" />
        <circle cx="28" cy="17" r="2.6" fill="#F0917C" />
      </svg>
    </span>
  );
}

export function QualifyLandingHero() {
  return (
    <section
      aria-label="Search to qualify a lead"
      className="q-hero animate-ths-reveal relative flex min-h-[360px] items-center justify-center overflow-hidden rounded-2xl border border-line px-6 py-16 sm:min-h-[420px] sm:py-20"
      style={{ background: 'linear-gradient(180deg, #FDFBF8 0%, #FBF8F4 100%)' }}
    >
      {/* atmosphere — slow-drifting soft glows */}
      <div aria-hidden className="pointer-events-none absolute inset-0">
        <span className="q-hero-glow q-hero-glow--a" />
        <span className="q-hero-glow q-hero-glow--b" />
        <span className="q-hero-glow q-hero-glow--c" />
      </div>

      {/* faint constellation */}
      <svg
        aria-hidden
        className="q-hero-net pointer-events-none absolute inset-0 h-full w-full"
        viewBox="0 0 720 320"
        preserveAspectRatio="xMidYMid slice"
      >
        <g className="net-grp">
          {LINKS.map(([a, b], i) => (
            <line
              key={`l${i}`}
              className="net-link"
              x1={NODES[a]!.x}
              y1={NODES[a]!.y}
              x2={NODES[b]!.x}
              y2={NODES[b]!.y}
            />
          ))}
          {NODES.map((n, i) => (
            <circle
              key={`n${i}`}
              className={`net-node${n.kind === 'hub' ? ' hub' : n.kind === 'warm' ? ' warm' : ''}`}
              cx={n.x}
              cy={n.y}
              r={n.kind === 'hub' ? 6.5 : 4}
              style={{ animationDelay: `${n.d}s` }}
            />
          ))}
        </g>
      </svg>

      {/* prompt */}
      <div className="relative mx-auto flex max-w-md flex-col items-center text-center">
        <HeroMark />
        <h2 className="mt-5 font-display text-2xl font-medium tracking-tight text-ink900 sm:text-[26px]">
          Search to qualify a lead
        </h2>
        <p className="mt-2 text-sm leading-relaxed text-ink600">
          Enter a member ID, a 3-letter alpha prefix, or a client name — or tap a{' '}
          <span className="font-semibold text-teal700">Facility Heating Up</span> above to resolve its payer.
        </p>
        <div className="mt-5 flex flex-wrap items-center justify-center gap-2 text-[11px] font-semibold">
          {['Member ID', 'Alpha prefix', 'Client name'].map((t) => (
            <span key={t} className="rounded-full border border-teal200 bg-teal50/70 px-2.5 py-1 text-teal700">
              {t}
            </span>
          ))}
        </div>
      </div>
    </section>
  );
}
