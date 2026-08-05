'use server';

/**
 * Facility Resolution SERVER ACTIONS — the browser's only path to the 0086 resolution matview
 * and the 0085 manual-assignment store. Discipline mirrors the registry write surface
 * (qualify/registry-actions.ts, the stated exemplar):
 *
 *   gate (admin/super_admin, fail-closed; admissions_seat and 'user' never reach here) →
 *   zod-validate (strict, bounded) → tenant-containment + roster-containment checks →
 *   ONE definer-function write → matview refresh → access-audit line.
 *
 * Reads and writes both run as claims_reader: reads on the matview's SELECT grant, the write
 * through EXECUTE on collections.save_facility_assignments (SECURITY DEFINER — the 0047
 * grid-view precedent). Never claims_admin, never the service key.
 *
 * PHI: member_id_bidx is the only member-shaped value on this surface — a keyed-HMAC token,
 * never a raw identifier. It is never logged and never placed in a URL. Error strings returned
 * to the client are generic; sqlstate-only details go to console.error.
 */
import { z } from 'zod';
import { dashboardAccess } from '@/lib/access';
import { clampView, viewToEntityIds, type DashboardView } from '@/lib/views';
import {
  loadFacilityResolutionOverview,
  loadFacilityResolutionQueue,
  loadResolutionFacilityOptions,
  expandMemberUnresolvedKeys,
  saveFacilityAssignmentsAndRefresh,
  parseResolutionSearch,
  resolveResolutionSort,
  resolveResolutionCursor,
  recordAccess,
  RESOLUTION_METHODS,
  type ResolutionRow,
  type ResolutionOverviewRow,
  type ResolutionChip,
  type ResolutionChargeKey,
  type ResolutionSort,
  type ResolutionCursor,
} from '@/lib/server';

const LOAD_ERROR = 'Facility Resolution could not be loaded right now.';
const SAVE_ERROR = 'The assignment could not be saved right now.';

interface Principal {
  userId: string;
  email: string;
  entityIds: string[];
}

/** Gate + scope in one place. Mirrors actions.ts viewEntityScope (deliberately re-derived —
 *  the client-supplied view is a display hint; entitlement comes from the RBAC row), PLUS the
 *  surface's own role gate: admin/super_admin only, real principal only. */
async function resolutionPrincipal(view?: string): Promise<Principal | null> {
  const result = await dashboardAccess();
  if (!result.ok) return null;
  const { access } = result;
  if (!access.user) return null; // staged-rollout fallback has no real principal — fail closed
  if (access.role !== 'admin' && access.role !== 'super_admin') return null;
  if (access.allowedViews.length === 0) return null;
  const requested = (view ?? access.allowedViews[0]!) as DashboardView;
  const entityIds = viewToEntityIds(clampView(requested, access.allowedViews));
  if (entityIds.length === 0) return null;
  return { userId: access.user.id, email: access.user.email, entityIds };
}

const SearchSchema = z.string().max(200).catch('');
const MethodSchema = z
  .array(z.enum(RESOLUTION_METHODS))
  .max(RESOLUTION_METHODS.length)
  .optional();
const SortSchema = z
  .object({
    column: z.enum(['charge_date', 'payment_received', 'charge_amount', 'insurance_payments']),
    direction: z.enum(['asc', 'desc']),
  })
  .strict()
  .optional();
const CursorSchema = z
  .object({ id: z.number().int().min(1), value: z.union([z.string().max(64), z.number(), z.null()]) })
  .strict()
  .nullable()
  .optional();

export interface ResolutionQueueResult {
  ok: boolean;
  error?: string;
  rows?: ResolutionRow[];
  nextCursor?: ResolutionCursor | null;
  /** Every chip the search input parsed to — unmatched ones included, so the UI can render
   *  them as inert "didn't understand this" chips rather than guessing. */
  chips?: ResolutionChip[];
}

/** One queue page. Search is parsed server-side into structured filters (never interpolated);
 *  explicit method filters (the segmented control) merge with any method chips from the text. */
export async function queryResolutionQueue(
  view: string | undefined,
  searchInput: string,
  methodsInput?: string[],
  sortInput?: ResolutionSort,
  cursorInput?: ResolutionCursor | null,
): Promise<ResolutionQueueResult> {
  const principal = await resolutionPrincipal(view);
  if (principal === null) return { ok: false, error: LOAD_ERROR };
  try {
    const search = SearchSchema.parse(searchInput ?? '');
    const methods = MethodSchema.parse(methodsInput);
    const sort = resolveResolutionSort(SortSchema.parse(sortInput ?? undefined));
    const cursor = resolveResolutionCursor(CursorSchema.parse(cursorInput ?? null) ?? null);

    const parsed = parseResolutionSearch(search);
    const applied: ResolutionChip[] = [...parsed.applied];
    for (const m of methods ?? []) {
      if (!applied.some((c) => c.kind === 'method' && c.method === m)) {
        applied.push({ kind: 'method', method: m, label: `method: ${m}` });
      }
    }
    const page = await loadFacilityResolutionQueue(applied, sort, cursor, principal.entityIds);
    return { ok: true, rows: page.rows, nextCursor: page.nextCursor, chips: parsed.chips };
  } catch (err) {
    console.error(
      'facility-resolution: queue query failed:',
      err instanceof Error ? err.message.slice(0, 200) : 'unknown',
    );
    return { ok: false, error: LOAD_ERROR };
  }
}

export interface ResolutionOverviewResult {
  ok: boolean;
  error?: string;
  overview?: ResolutionOverviewRow[];
  facilities?: Array<{ facility_code: string; facility_name: string }>;
}

/** Overview tiles + the assignment picker's canonical facility options. */
export async function loadResolutionOverview(view?: string): Promise<ResolutionOverviewResult> {
  const principal = await resolutionPrincipal(view);
  if (principal === null) return { ok: false, error: LOAD_ERROR };
  try {
    const [overview, facilities] = await Promise.all([
      loadFacilityResolutionOverview(principal.entityIds),
      loadResolutionFacilityOptions(principal.entityIds),
    ]);
    return { ok: true, overview, facilities };
  } catch (err) {
    console.error(
      'facility-resolution: overview load failed:',
      err instanceof Error ? err.message.slice(0, 200) : 'unknown',
    );
    return { ok: false, error: LOAD_ERROR };
  }
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ChargeKeySchema = z
  .object({
    business_entity_id: z.string().regex(UUID_RE),
    member_id_bidx: z.string().regex(/^[0-9a-f]{8,128}$/i),
    charge_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    cpt_key: z.string().max(40),
    revenue_key: z.string().max(40),
    charge_amount: z.string().regex(/^-?\d{1,9}(\.\d{1,2})?$/),
  })
  .strict();

const AssignInputSchema = z
  .object({
    facility_code: z.string().trim().min(1).max(40),
    note: z.string().trim().min(1).max(500),
    scope: z.enum(['charges', 'members']),
    charges: z.array(ChargeKeySchema).min(1).max(500),
  })
  .strict();

export type AssignFacilityInput = z.input<typeof AssignInputSchema>;
export type AssignFacilityResult = { ok: true; written: number } | { ok: false; error: string };

/**
 * Record manual assignments. scope 'charges' assigns exactly the given keys; scope 'members'
 * expands to EVERY unresolved charge of the selected keys' members (the bulk-by-member path) —
 * the expansion happens HERE, server-side, from the matview, never from client-supplied lists.
 */
export async function assignFacility(
  view: string | undefined,
  input: AssignFacilityInput,
): Promise<AssignFacilityResult> {
  const principal = await resolutionPrincipal(view);
  if (principal === null) return { ok: false, error: SAVE_ERROR };

  const parsed = AssignInputSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? 'Invalid assignment.' };
  }
  const d = parsed.data;

  // Tenant containment: every charge key must belong to the caller's entitled scope. A key for
  // another tenant is a forged input, not a validation nuance — refuse the whole batch.
  for (const c of d.charges) {
    if (!principal.entityIds.some((id) => id.toLowerCase() === c.business_entity_id.toLowerCase())) {
      return { ok: false, error: 'Assignment outside your tenant scope.' };
    }
  }

  // Roster containment (the cross-book guard, applied to humans too): the target facility must
  // be on the entitled entities' OWN roster — the DB function only checks the code exists.
  try {
    const roster = await loadResolutionFacilityOptions(principal.entityIds);
    if (!roster.some((f) => f.facility_code === d.facility_code)) {
      return { ok: false, error: 'That facility is not on this book’s roster.' };
    }

    let charges: ResolutionChargeKey[] = d.charges;
    if (d.scope === 'members') {
      const members = [...new Set(d.charges.map((c) => c.member_id_bidx.toLowerCase()))];
      if (members.length > 50) return { ok: false, error: 'Select at most 50 members per bulk assignment.' };
      charges = await expandMemberUnresolvedKeys(principal.entityIds, members);
      if (charges.length === 0) return { ok: false, error: 'No unresolved charges found for the selected members.' };
    }

    const written = await saveFacilityAssignmentsAndRefresh({
      userId: principal.userId,
      email: principal.email,
      facilityCode: d.facility_code,
      note: d.note,
      charges,
    });

    // Access-audit line: counts + code only — no member token, no note text.
    await recordAccess({
      actorEmail: principal.email,
      actorUserId: principal.userId,
      action: 'facility_assignment_write',
      detail: { charges: written, facility_code: d.facility_code, scope: d.scope },
    });

    return { ok: true, written };
  } catch (err) {
    console.error(
      'facility-resolution: assignment failed:',
      err instanceof Error ? err.message.slice(0, 200) : 'unknown',
    );
    return { ok: false, error: SAVE_ERROR };
  }
}
