'use client';

/**
 * Qualify LANDING HERO — the animated brand panel that fills the resolved-subject area on a FRESH landing
 * (before any search). Purely DECORATIVE + the search guidance: no data, no PHI, no props. The subject /
 * facilities / Recent-Claims grid replaces it the moment a search or a Heating-Up tap resolves a payer.
 *
 * Aesthetic (warm-clinical teal, deliberately simple): a soft drifting glow behind a breathing brand
 * monogram + Fraunces prompt, with a single moving teal "comet" that travels the OUTSIDE edge of the box
 * (the animated border) — the motion lives on the frame, not inside, so the center stays calm and
 * readable. All motion is CSS-only (`.q-hero-*` in globals.css) and collapses to static under the global
 * prefers-reduced-motion reset.
 *
 * NOTE: the monogram is an abstract on-brand mark — drop a real logo SVG (TreatHealth / BXR / Indigo) in
 * place of `<HeroMark/>` if you'd rather show actual logos.
 */

import { QUALIFY_CLIENT_NAME_ENABLED } from '@/lib/qualify/contract';

function HeroMark() {
  return (
    <span
      className="q-hero-mark relative inline-flex h-16 w-16 items-center justify-center rounded-2xl"
      style={{ background: 'linear-gradient(135deg, #0E3A3A 0%, #135E5A 60%, #1C8B82 100%)' }}
      aria-hidden
    >
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
      className="q-hero q-hero-border animate-ths-reveal relative flex min-h-[360px] items-center justify-center overflow-hidden rounded-2xl border border-line px-6 py-16 sm:min-h-[420px] sm:py-20"
      style={{ background: 'linear-gradient(180deg, #FDFBF8 0%, #FBF8F4 100%)' }}
    >
      {/* atmosphere — a couple of slow, soft glows behind the text (no lines/dots) */}
      <div aria-hidden className="pointer-events-none absolute inset-0">
        <span className="q-hero-glow q-hero-glow--a" />
        <span className="q-hero-glow q-hero-glow--b" />
      </div>

      {/* prompt (above the frame's traveling comet) */}
      <div className="relative z-[2] mx-auto flex max-w-md flex-col items-center text-center">
        <HeroMark />
        <h2 className="mt-5 font-display text-2xl font-medium tracking-tight text-ink900 sm:text-[26px]">
          Search to qualify a lead
        </h2>
        <p className="mt-2 text-sm leading-relaxed text-ink600">
          Enter{' '}
          {QUALIFY_CLIENT_NAME_ENABLED
            ? 'a member ID, a 3-letter alpha prefix, or a client name'
            : 'a member ID or a 3-letter alpha prefix'}{' '}
          — or tap a <span className="font-semibold text-teal700">Facility Heating Up</span> above to resolve its
          payer.
        </p>
        <div className="mt-5 flex flex-wrap items-center justify-center gap-2 text-[11px] font-semibold">
          {(QUALIFY_CLIENT_NAME_ENABLED
            ? ['Member ID', 'Alpha prefix', 'Client name']
            : ['Member ID', 'Alpha prefix']
          ).map((t) => (
            <span key={t} className="rounded-full border border-teal200 bg-teal50/70 px-2.5 py-1 text-teal700">
              {t}
            </span>
          ))}
        </div>
      </div>
    </section>
  );
}
