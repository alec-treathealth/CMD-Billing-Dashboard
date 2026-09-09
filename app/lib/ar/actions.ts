'use server';

/**
 * AR Management Server Actions — the browser's ONLY data path for the AR Queue tab (standing rule,
 * nextjs-app.md). Thin binders: gate → clamp every client value → server.ts. ⚠ A `'use server'` file
 * may export ONLY async functions — one non-function export 500s every action on the page (memory:
 * use-server-export-kills-all-actions); constants and types live in contract.ts, factories in deps.ts.
 *
 * GATES (server-side, per call — there is no ambient check):
 *   · every read: a signed-in, provisioned principal whose RBAC entitlement ∩ this screen's planes
 *     (BXR / Indigo, via resolveClaimsDeskView) is non-empty; the tenant scope is the CLAMPED view,
 *     never the client's string;
 *   · notes (decrypted) and identifier reveals: canRevealPhi (admin / super_admin), AUDITED;
 *   · writes (add note / set work): admin or super_admin — working a claim requires seeing PHI;
 *   · notifications: super_admin only (the bell is a super-admin surface by request).
 * Every action returns a typed union and never echoes an internal error to the client.
 */
import { BlindIndexError, memberIdBlindIndex, patientNameBlindIndex, patientNameNormalized, patientNamePrefixBlindIndex } from '../../../src/collections/blindIndex.js';
import { businessDayIso } from '../../../src/businessWindow.js';
import { AR_WORK_STATUSES, resolveArCursor, resolveArFilter, resolveArSort, type ArWorkStatus } from '../../../src/billingAudit/arQuery.js';
import { dashboardAccess } from '../access';
import { resolveClaimsDeskView } from '../billing-audit/views';
import { recordAccess } from '../server';
import { isQualifyOnlyRole, type Role } from '../rbac';
import { viewToEntityIds, type DashboardView } from '../views';
import type {
  ArClaimDetailResult, ArMutationResult, ArNotesResult, ArNotificationsResult, ArOptionsResult, ArQueueResult,
  ArRevealResult, ArRevealRowsResult, ArSearchResult, ArSummaryResult, ArWorkPatch,
} from './contract';
import {
  addArNote, loadArClaimDetail, loadArNotes, loadArNotifications, loadArOptions, loadArQueuePage, loadArSummary,
  markArNotificationsSeen, revealArPatient, revealArPatients, setArWork, type ArActor,
} from './server';

const GENERIC = 'AR Management could not be loaded right now.';
const CMD_ID_RE = /^[0-9]{1,20}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

interface Scope {
  view: DashboardView;
  entityIds: string[];
  entityId: string;
  actor: ArActor;
  role: Role;
  canRevealPhi: boolean;
}
type ScopeResult = { ok: true; scope: Scope } | { ok: false; error: string };

async function arScope(view: unknown): Promise<ScopeResult> {
  const result = await dashboardAccess();
  if (!result.ok) return { ok: false, error: result.reason === 'unprovisioned' ? 'Your account is not provisioned for this dashboard.' : 'Sign in to view AR Management.' };
  const { access } = result;
  if (!access.user) return { ok: false, error: 'AR Management requires per-user sign-in.' }; // no-auth fallback: fail closed
  if (isQualifyOnlyRole(access.role)) return { ok: false, error: 'Your role does not include AR Management.' };
  const requested = typeof view === 'string' ? view : undefined;
  const resolved = resolveClaimsDeskView(requested === undefined ? undefined : { view: requested }, access.allowedViews);
  if (resolved === null) return { ok: false, error: 'Your account is not scoped to any AR data.' };
  const entityIds = viewToEntityIds(resolved);
  const entityId = entityIds[0];
  if (!entityId || entityIds.length !== 1) return { ok: false, error: 'AR Management is single-tenant.' };
  return {
    ok: true,
    scope: {
      view: resolved,
      entityIds,
      entityId,
      actor: { email: access.user.email, userId: access.user.id },
      role: access.role,
      canRevealPhi: access.canRevealPhi,
    },
  };
}

const canWork = (role: Role): boolean => role === 'admin' || role === 'super_admin';

function cleanClaimId(v: unknown): string | null {
  return typeof v === 'string' && CMD_ID_RE.test(v.trim()) ? v.trim() : null;
}

export async function loadArQueue(view: unknown, cursor: unknown, filter: unknown, sort: unknown): Promise<ArQueueResult> {
  const s = await arScope(view);
  if (!s.ok) return { ok: false, error: s.error };
  try {
    const page = await loadArQueuePage(resolveArCursor(cursor), resolveArFilter(filter), resolveArSort(sort), s.scope.entityIds, businessDayIso());
    return { ok: true, rows: page.rows, nextCursor: page.nextCursor };
  } catch (err) {
    console.error('loadArQueue failed', err instanceof Error ? err.message : '');
    return { ok: false, error: GENERIC };
  }
}

export async function loadArSummaryAction(view: unknown, filter: unknown): Promise<ArSummaryResult> {
  const s = await arScope(view);
  if (!s.ok) return { ok: false, error: s.error };
  try {
    return { ok: true, summary: await loadArSummary(resolveArFilter(filter), s.scope.entityIds, businessDayIso()) };
  } catch (err) {
    console.error('loadArSummaryAction failed', err instanceof Error ? err.message : '');
    return { ok: false, error: GENERIC };
  }
}

export async function loadArOptionsAction(view: unknown): Promise<ArOptionsResult> {
  const s = await arScope(view);
  if (!s.ok) return { ok: false, error: s.error };
  try {
    return { ok: true, options: await loadArOptions(s.scope.entityIds) };
  } catch (err) {
    console.error('loadArOptionsAction failed', err instanceof Error ? err.message : '');
    return { ok: false, error: GENERIC };
  }
}

export async function loadArClaimDetailAction(view: unknown, claimId: unknown): Promise<ArClaimDetailResult> {
  const s = await arScope(view);
  if (!s.ok) return { ok: false, error: s.error };
  const id = cleanClaimId(claimId);
  if (!id) return { ok: false, error: 'Invalid claim.' };
  try {
    const detail = await loadArClaimDetail(id, s.scope.entityIds, businessDayIso());
    if (!detail) return { ok: false, error: 'Claim not found in your scope.' };
    return { ok: true, detail };
  } catch (err) {
    console.error('loadArClaimDetailAction failed', err instanceof Error ? err.message : '');
    return { ok: false, error: GENERIC };
  }
}

/** Notes carry incidental PHI (rep follow-up text) — gated to canRevealPhi and audited by claim id. */
export async function loadArNotesAction(view: unknown, claimId: unknown, patientId: unknown): Promise<ArNotesResult> {
  const s = await arScope(view);
  if (!s.ok) return { ok: false, error: s.error };
  if (!s.scope.canRevealPhi) return { ok: false, error: 'Your role does not permit reading follow-up notes.' };
  const cid = cleanClaimId(claimId);
  const pid = cleanClaimId(patientId);
  if (!cid || !pid) return { ok: false, error: 'Invalid claim.' };
  try {
    await recordAccess({ actorEmail: s.scope.actor.email, actorUserId: s.scope.actor.userId, action: 'read_ar_notes', detail: { cmd_claim_id: cid, view: s.scope.view } });
    return { ok: true, notes: await loadArNotes(cid, pid, s.scope.entityIds) };
  } catch (err) {
    console.error('loadArNotesAction failed', err instanceof Error ? err.message : '');
    return { ok: false, error: 'Notes could not be loaded right now.' };
  }
}

export async function revealArPatientAction(view: unknown, patientId: unknown): Promise<ArRevealResult> {
  const s = await arScope(view);
  if (!s.ok) return { ok: false, error: s.error };
  if (!s.scope.canRevealPhi) return { ok: false, error: 'Your role does not permit revealing patient identifiers.' };
  const pid = cleanClaimId(patientId);
  if (!pid) return { ok: false, error: 'Invalid patient.' };
  try {
    const patient = await revealArPatient(pid, s.scope.actor, s.scope.entityIds);
    if (!patient) return { ok: false, error: 'Patient not found in your scope.' };
    return { ok: true, patient };
  } catch (err) {
    console.error('revealArPatientAction failed', err instanceof Error ? err.message : '');
    return { ok: false, error: 'Could not reveal patient identifiers.' };
  }
}

/** Bulk reveal for the page-level toggle — ids bounded to 200, one audit row. */
export async function revealArPatientsAction(view: unknown, patientIds: unknown): Promise<ArRevealRowsResult> {
  const s = await arScope(view);
  if (!s.ok) return { ok: false, error: s.error };
  if (!s.scope.canRevealPhi) return { ok: false, error: 'Your role does not permit revealing patient identifiers.' };
  const ids = Array.isArray(patientIds) ? [...new Set(patientIds.map(cleanClaimId).filter((x): x is string => x !== null))].slice(0, 200) : [];
  if (ids.length === 0) return { ok: true, patients: [] };
  try {
    return { ok: true, patients: await revealArPatients(ids, s.scope.actor, s.scope.entityIds) };
  } catch (err) {
    console.error('revealArPatientsAction failed', err instanceof Error ? err.message : '');
    return { ok: false, error: 'Could not reveal patient identifiers.' };
  }
}

export async function addArNoteAction(view: unknown, claimId: unknown, text: unknown): Promise<ArMutationResult> {
  const s = await arScope(view);
  if (!s.ok) return { ok: false, error: s.error };
  if (!canWork(s.scope.role)) return { ok: false, error: 'Your role cannot add notes.' };
  const cid = cleanClaimId(claimId);
  const body = typeof text === 'string' ? text.trim() : '';
  if (!cid) return { ok: false, error: 'Invalid claim.' };
  if (body.length < 1 || body.length > 4000) return { ok: false, error: 'A note must be 1–4000 characters.' };
  try {
    await addArNote(s.scope.actor, s.scope.entityId, cid, body);
    return { ok: true };
  } catch (err) {
    console.error('addArNoteAction failed', err instanceof Error ? err.message : '');
    return { ok: false, error: 'The note could not be saved right now.' };
  }
}

export async function setArWorkAction(view: unknown, claimId: unknown, patch: unknown): Promise<ArMutationResult> {
  const s = await arScope(view);
  if (!s.ok) return { ok: false, error: s.error };
  if (!canWork(s.scope.role)) return { ok: false, error: 'Your role cannot change work status.' };
  const cid = cleanClaimId(claimId);
  if (!cid) return { ok: false, error: 'Invalid claim.' };
  const p = typeof patch === 'object' && patch !== null ? (patch as Record<string, unknown>) : {};
  const status = typeof p.workStatus === 'string' && (AR_WORK_STATUSES as readonly string[]).includes(p.workStatus) ? (p.workStatus as ArWorkStatus) : null;
  if (!status) return { ok: false, error: 'Invalid work status.' };
  const assigneeUserId = typeof p.assigneeUserId === 'string' && UUID_RE.test(p.assigneeUserId) ? p.assigneeUserId : null;
  const assigneeEmail = typeof p.assigneeEmail === 'string' && p.assigneeEmail.trim().length >= 3 && p.assigneeEmail.length <= 320 ? p.assigneeEmail.trim().toLowerCase() : null;
  if ((assigneeUserId === null) !== (assigneeEmail === null)) return { ok: false, error: 'Invalid assignee.' };
  const dueOn = typeof p.dueOn === 'string' && ISO_DATE.test(p.dueOn) ? p.dueOn : null;
  const resolutionCode = typeof p.resolutionCode === 'string' && p.resolutionCode.trim().length > 0 ? p.resolutionCode.trim().slice(0, 60) : null;
  const clean: ArWorkPatch = { workStatus: status, assigneeUserId, assigneeEmail, dueOn, resolutionCode };
  try {
    await setArWork(s.scope.actor, s.scope.entityId, cid, clean);
    return { ok: true };
  } catch (err) {
    console.error('setArWorkAction failed', err instanceof Error ? err.message : '');
    return { ok: false, error: 'The work status could not be saved right now.' };
  }
}

/**
 * Resolve a patient search term to opaque blind-index tokens (a PHI op: gated + audited, field
 * NAMES only in the audit). A term that looks like a member id (has a digit) also tries the
 * member-id token; ≤3 letters → name prefix; longer → exact name.
 */
export async function searchArPatientsAction(view: unknown, term: unknown): Promise<ArSearchResult> {
  const t = typeof term === 'string' ? term.trim() : '';
  if (t === '') return { ok: true, tokens: {} };
  if (t.length > 120) return { ok: false, error: 'Invalid search.' };
  const s = await arScope(view);
  if (!s.ok) return { ok: false, error: s.error };
  if (!s.scope.canRevealPhi) return { ok: false, error: 'Your role does not permit patient search.' };
  const tokens: { patientNameBidx?: string[]; patientNamePrefixBidx?: string[]; memberIdBidx?: string[] } = {};
  try {
    const norm = patientNameNormalized(t);
    if (norm && norm.length <= 3) {
      const pfx = patientNamePrefixBlindIndex(t);
      if (pfx) tokens.patientNamePrefixBidx = [pfx];
    } else {
      const exact = patientNameBlindIndex(t);
      if (exact) tokens.patientNameBidx = [exact];
    }
    if (/\d/.test(t)) {
      const m = memberIdBlindIndex(t);
      if (m) tokens.memberIdBidx = [m];
    }
  } catch (e) {
    if (e instanceof BlindIndexError) return { ok: false, error: 'Search is temporarily unavailable.' };
    throw e;
  }
  const fields = Object.keys(tokens);
  if (fields.length === 0) return { ok: true, tokens: {} };
  await recordAccess({ actorEmail: s.scope.actor.email, actorUserId: s.scope.actor.userId, action: 'search_ar_phi', detail: { fields, view: s.scope.view } });
  return { ok: true, tokens };
}

/** Super-admin only: recent AR changes by other people + the unread count against the caller's cursor. */
export async function loadArNotificationsAction(): Promise<ArNotificationsResult> {
  const result = await dashboardAccess();
  if (!result.ok || !result.access.user) return { ok: false, error: 'Sign in required.' };
  if (result.access.role !== 'super_admin') return { ok: false, error: 'Notifications are a super-admin surface.' };
  const entityIds = [...new Set(result.access.allowedViews.filter((v) => v !== 'consolidated').flatMap(viewToEntityIds))];
  if (entityIds.length === 0) return { ok: false, error: 'No scope.' };
  try {
    return { ok: true, payload: await loadArNotifications(result.access.user.id, entityIds) };
  } catch (err) {
    console.error('loadArNotificationsAction failed', err instanceof Error ? err.message : '');
    return { ok: false, error: 'Notifications are unavailable right now.' };
  }
}

export async function markArNotificationsSeenAction(): Promise<ArMutationResult> {
  const result = await dashboardAccess();
  if (!result.ok || !result.access.user) return { ok: false, error: 'Sign in required.' };
  if (result.access.role !== 'super_admin') return { ok: false, error: 'Notifications are a super-admin surface.' };
  try {
    await markArNotificationsSeen(result.access.user.id);
    return { ok: true };
  } catch (err) {
    console.error('markArNotificationsSeenAction failed', err instanceof Error ? err.message : '');
    return { ok: false, error: 'Could not update notifications.' };
  }
}
