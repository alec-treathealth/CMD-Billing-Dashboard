/**
 * /code-reference — RENAMED to /code-performance (2026-09-08, Alec). The static Phase 9 reference
 * table this route used to render (<CodeReference />, app/components/code-reference.tsx) is retired;
 * its curated text was seeded into ref.code_description (Veris 038) as prior_description with its
 * citations, and the new surface renders descriptions from that table. The component stays in git
 * history. Precedent for the stub: /claims and /ask.
 */
import { redirect } from 'next/navigation';

export default function CodeReferenceRedirect() {
  redirect('/code-performance');
}
