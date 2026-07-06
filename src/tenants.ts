/**
 * Canonical tenant (business_entity_id) constants for the root library (`src/`).
 *
 * These UUIDs are FIXED, permanent identifiers — never regenerate them (same rule as
 * BXR's). They are the single source of truth on the `src/` side for the two real
 * tenants, so brain/agent/ingest code parameterizes off a named constant instead of a
 * scattered inline literal.
 *
 * NOTE ON THE DUAL DECLARATION: `app/lib/views.ts` declares the same UUIDs on the
 * Next.js (`app/`) side (BXR_ENTITY_ID / INDIGO_ENTITY_ID). The two must agree, but the
 * root library cannot import from `app/` (the dependency points app → src, never the
 * reverse), so each side keeps its own constant. Both derive from the same business-
 * owner-confirmed fixed UUIDs — do not let them diverge.
 *
 * This is a REGISTRY of ids, not a scoping mechanism: RLS isolation is still enforced
 * per-transaction via `set_config('app.business_entity_id', <uuid>, ...)` on the
 * tenant-scoped `staging.*` tables (see docs/CLAUDE.md §17).
 */

/** BXR Consulting LLC — CMD account 475729. The only tenant with real data before Indigo. */
export const BXR_ENTITY_ID = 'af504ab6-3dcd-4aa4-a93c-27bc58de4088';

/** Indigo Billing — CMD account 474623. Onboarded as the second real tenant. */
export const INDIGO_ENTITY_ID = '141d459c-f371-4229-9a92-ace198e940bb';
