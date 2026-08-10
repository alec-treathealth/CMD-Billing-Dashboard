/**
 * ADMISSIONS-FACING SECTION LABELS (Smoke, 2026-08-10) — what the three AI answer sections are
 * CALLED on the Qualify surface.
 *
 * THE WIRE MARKERS DO NOT CHANGE. The model still emits `## TL;DR` / `## Signals` / `## Risks`,
 * because `parseAiSections` (src/collections/aiAnalysis.ts) matches those exact headers and is
 * SHARED with the Collections AI panel — changing what the model emits would break both surfaces
 * and every scrubber/parser test pinned to them. This map is presentation only: Qualify renders
 * friendlier headings over the same parsed sections. Alec's directive (2026-08-10): admissions
 * people are the audience — "too many numbers and technical terms will throw them off."
 *
 * Collections keeps TL;DR/Signals/Risks — its audience is the billing team, and those are their
 * words. Do not import this map there.
 */
import type { AiSection } from '../../../src/collections/aiAnalysis';

export const QUALIFY_AI_SECTION_LABELS: Record<AiSection, string> = {
  'TL;DR': 'Bottom line',
  Signals: 'What we see',
  Risks: 'Watch out for',
};
