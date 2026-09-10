/**
 * AR Management — server-side loaders and writers (the composition root for /billing-audit's AR
 * Queue). SERVER-ONLY: reads run through the claims_reader executor; human writes call the
 * claims_admin-owned SECURITY DEFINER functions from 0109/0110 with the SERVER-resolved actor;
 * PHI is decrypted here, in-process, only behind the gates actions.ts enforces.
 *
 * CACHING: the queue page, the aging summary and the filter options are NON-PHI projections and are
 * wrapped in unstable_cache under the AR_CACHE_TAG (busted by the ingest and by every human write).
 * Claim detail, notes (decrypted), reveals and notifications are never cached.
 *
 * Every function takes `entityIds` already clamped by RBAC — nothing here widens scope.
 */
import { revalidateTag, unstable_cache } from 'next/cache';
import { AR_CACHE_TAG } from '../../../src/billingAudit/arConfig.js';
import {
  AR_PAGE_SIZE,
  arSortValue,
  buildArAssigneeLookupQuery,
  buildArAssigneeOptionsQuery,
  buildArChargeLinesQuery,
  buildArClaimPatientQuery,
  buildArClaimQuery,
  buildArEventsQuery,
  buildArFacilityOptionsQuery,
  buildArFreshnessQuery,
  buildArKpiQuery,
  buildArNotesQuery,
  buildArNotificationCountQuery,
  buildArNotificationsQuery,
  buildArPatientRevealQuery,
  buildArPatientsRevealQuery,
  buildArPayerOptionsQuery,
  buildArQueueQuery,
  buildArRemitsQuery,
  buildArStatusEventsQuery,
  buildArSummaryQuery,
  type ArAssigneeOption,
  type ArBandSummaryRow,
  type ArChargeLineRow,
  type ArCursor,
  type ArEventRow,
  type ArFacilityOption,
  type ArFilter,
  type ArKpiRow,
  type ArNoteEncRow,
  type ArNotificationRow,
  type ArPayerOption,
  type ArQueueRow,
  type ArRemitRow,
  type ArSort,
  type ArStatusEventRow,
  buildArLatestNotesQuery,
  type ArLatestNoteEncRow,
} from '../../../src/billingAudit/arQuery.js';
import { decryptPhi, encryptPhi } from '../../../src/collections/phiCrypto.js';
import { recordAccess } from '@/lib/server';
import { arExecutor } from './deps';
import type { ArClaimDetail, ArFreshness, ArNote, ArNotificationsPayload, ArOptions, ArRevealedPatient, ArSummary, ArWorkPatch, ArLatestNote } from './contract';

export interface ArActor {
  email: string;
  userId: string;
}

type Row = Record<string, unknown>;

/** pg returns bigint identity columns as strings; the client contract says number. */
function toQueueRow(r: Row): ArQueueRow {
  return {
    ...(r as unknown as ArQueueRow),
    id: Number(r.id),
    age_days: r.age_days === null || r.age_days === undefined ? null : Number(r.age_days),
    cmd_note_count: Number(r.cmd_note_count ?? 0),
    cpt_codes: Array.isArray(r.cpt_codes) ? (r.cpt_codes as string[]) : [],
    rev_codes: Array.isArray(r.rev_codes) ? (r.rev_codes as string[]) : [],
    denial_summary: Array.isArray(r.denial_summary) ? (r.denial_summary as ArQueueRow['denial_summary']) : [],
  };
}

async function loadArQueuePageUncached(cursor: ArCursor | null, filter: ArFilter, sort: ArSort, entityIds: string[], asOf: string) {
  const limit = AR_PAGE_SIZE + 1;
  const { sql, params } = buildArQueueQuery(cursor, filter, sort, limit, entityIds, asOf);
  const { rows } = await arExecutor().query<Row>(sql, params);
  const hasMore = rows.length > AR_PAGE_SIZE;
  const page = (hasMore ? rows.slice(0, AR_PAGE_SIZE) : rows).map(toQueueRow);
  const last = page[page.length - 1];
  const nextCursor: ArCursor | null = hasMore && last ? { id: last.id, value: arSortValue(last, sort.column) } : null;
  return { rows: page, nextCursor };
}

/** NON-PHI queue page, cached 5 min per (cursor, filter, sort, tenant, asOf). */
export const loadArQueuePage = unstable_cache(loadArQueuePageUncached, ['ar-queue-page'], { revalidate: 300, tags: [AR_CACHE_TAG] });

export const loadArSummary = unstable_cache(
  async (filter: ArFilter, entityIds: string[], asOf: string): Promise<ArSummary> => {
    const s = buildArSummaryQuery(filter, entityIds, asOf);
    const k = buildArKpiQuery(filter, entityIds, asOf);
    const exec = arExecutor();
    const [bands, kpi] = await Promise.all([exec.query<Row>(s.sql, s.params), exec.query<Row>(k.sql, k.params)]);
    const kr = kpi.rows[0] ?? {};
    return {
      bands: bands.rows.map((r) => ({ band: (r.band as ArBandSummaryRow['band']) ?? null, claims: Number(r.claims ?? 0), balance: String(r.balance ?? '0') })),
      kpi: {
        claims: Number(kr.claims ?? 0),
        balance: String(kr.balance ?? '0'),
        denied: Number(kr.denied ?? 0),
        denied_balance: String(kr.denied_balance ?? '0'),
        worked: Number(kr.worked ?? 0),
        followup_overdue: Number(kr.followup_overdue ?? 0),
        never_noted: Number(kr.never_noted ?? 0),
        aged_31_plus: Number(kr.aged_31_plus ?? 0),
        aged_31_plus_balance: String(kr.aged_31_plus_balance ?? '0'),
      } satisfies ArKpiRow,
    };
  },
  ['ar-summary'],
  { revalidate: 300, tags: [AR_CACHE_TAG] },
);

export const loadArOptions = unstable_cache(
  // asOf enters the CACHE KEY as well as the queries: the option aggregates are age-bounded now, so
  // a cached set from yesterday would describe a different population than today's queue.
  async (entityIds: string[], entitySlug: string, asOf: string): Promise<ArOptions> => {
    const exec = arExecutor();
    const f = buildArFacilityOptionsQuery(entityIds, asOf);
    const p = buildArPayerOptionsQuery(entityIds, asOf);
    const a = buildArAssigneeOptionsQuery(entitySlug);
    const fr = buildArFreshnessQuery(entityIds);
    const [fac, pay, asg, fresh] = await Promise.all([
      exec.query<Row>(f.sql, f.params),
      exec.query<Row>(p.sql, p.params),
      exec.query<Row>(a.sql, a.params),
      exec.query<Row>(fr.sql, fr.params),
    ]);
    const fr0 = fresh.rows[0];
    const freshness: ArFreshness | null = fr0 && Number(fr0.customers ?? 0) > 0
      ? {
          customers: Number(fr0.customers),
          oldest_as_of: fr0.oldest_as_of === null ? null : String(fr0.oldest_as_of),
          newest_as_of: fr0.newest_as_of === null ? null : String(fr0.newest_as_of),
          last_run_finished_at: fr0.last_run_finished_at === null ? null : String(fr0.last_run_finished_at),
        }
      : null;
    return {
      facilities: fac.rows.map((r) => ({ facility_code: String(r.facility_code), facility_name: (r.facility_name as string | null) ?? null, n: Number(r.n ?? 0), balance: String(r.balance ?? '0') }) satisfies ArFacilityOption),
      payers: pay.rows.map((r) => ({ payer_name: String(r.payer_name), n: Number(r.n ?? 0), balance: String(r.balance ?? '0') }) satisfies ArPayerOption),
      assignees: asg.rows.map((r) => ({ user_id: String(r.user_id), email: String(r.email), role: String(r.role) }) satisfies ArAssigneeOption),
      freshness,
    };
  },
  ['ar-options'],
  { revalidate: 300, tags: [AR_CACHE_TAG] },
);

/** One claim's full detail (non-PHI). Uncached — it is what the biller is acting on right now. */
export async function loadArClaimDetail(cmdClaimId: string, entityIds: string[], asOf: string): Promise<ArClaimDetail | null> {
  const exec = arExecutor();
  const c = buildArClaimQuery(cmdClaimId, entityIds, asOf);
  const head = await exec.query<Row>(c.sql, c.params);
  const claimRow = head.rows[0];
  if (!claimRow) return null;
  const l = buildArChargeLinesQuery(cmdClaimId, entityIds);
  const r = buildArRemitsQuery(cmdClaimId, entityIds);
  const s = buildArStatusEventsQuery(cmdClaimId, entityIds);
  const e = buildArEventsQuery(cmdClaimId, entityIds);
  const [lines, remits, statusEvents, events] = await Promise.all([
    exec.query<Row>(l.sql, l.params),
    exec.query<Row>(r.sql, r.params),
    exec.query<Row>(s.sql, s.params),
    exec.query<Row>(e.sql, e.params),
  ]);
  return {
    claim: toQueueRow(claimRow),
    lines: lines.rows.map((x) => ({ ...(x as unknown as ArChargeLineRow), id: Number(x.id) })),
    remits: remits.rows.map((x) => ({ ...(x as unknown as ArRemitRow), id: Number(x.id), payer_level: x.payer_level === null ? null : Number(x.payer_level) })),
    statusEvents: statusEvents.rows.map((x) => ({ ...(x as unknown as ArStatusEventRow), id: Number(x.id) })),
    events: events.rows.map((x) => ({ ...(x as unknown as ArEventRow), id: Number(x.id), detail: (x.detail as Record<string, unknown>) ?? {} })),
  };
}

/**
 * The claim's notes, DECRYPTED in-process. Gated upstream to canRevealPhi (rep notes carry
 * incidental PHI). A note that fails to decrypt is surfaced as a placeholder, never dropped silently
 * — a corrupt row is an operational signal.
 */
export async function loadArNotes(cmdClaimId: string, entityIds: string[]): Promise<ArNote[]> {
  // The patient is DERIVED from the claim inside the tenant scope — never taken from the caller — so
  // a claim id can only ever unlock the notes of its own patient.
  const pq = buildArClaimPatientQuery(cmdClaimId, entityIds);
  const claim = await arExecutor().query<{ cmd_patient_id: string }>(pq.sql, pq.params);
  const cmdPatientId = claim.rows[0]?.cmd_patient_id;
  if (!cmdPatientId) return [];
  const q = buildArNotesQuery(cmdClaimId, cmdPatientId, entityIds);
  const { rows } = await arExecutor().query<ArNoteEncRow>(q.sql, q.params);
  return Promise.all(
    rows.map(async (r) => {
      let text: string;
      try {
        text = await decryptPhi(Buffer.from(r.note_enc));
      } catch {
        text = '[note could not be decrypted]';
      }
      return {
        id: Number(r.id),
        source: r.source,
        author: r.author_label,
        noted_at: r.noted_at,
        text,
        claim_level: r.cmd_claim_id !== null,
        note_type: r.note_type,
      };
    }),
  );
}

/**
 * The latest follow-up note for every claim on a queue page, decrypted.
 *
 * ⚠ DELIBERATELY NOT CACHED, and that is the whole reason this is a separate function rather than
 * extra columns on loadArQueuePage. That loader is wrapped in `unstable_cache`, and its payload is
 * PHI-FREE by construction — opaque CMD ids, money and derived status only. Note bodies are staff
 * free text about patients, so folding them into the cached structure would write PHI into Next's
 * data cache: a new at-rest surface outside the libsodium design, on disk, with none of its key
 * management. Keeping it uncached also means the audit row below fires on every disclosure rather
 * than once per five-minute cache window.
 *
 * PHI POSTURE — RULED BY ALEC 2026-09-10. This is served to EVERY role that can reach the queue,
 * including entity `user`, which `app/lib/rbac.ts` otherwise describes as NON-PHI. That is a
 * deliberate widening of the note surface for the AR desk, not an oversight, and it is recorded
 * here so a later reviewer does not read it as the bug it would otherwise look like. The read is
 * still AUDITED and still tenant-scoped; only the role gate changed.
 */
export async function loadArLatestNotes(
  pairs: readonly { cmdClaimId: string; cmdPatientId: string }[],
  actor: ArActor,
  entityIds: string[],
): Promise<Record<string, ArLatestNote>> {
  if (pairs.length === 0) return {};
  // Audit BEFORE the decrypt, the same ordering every other reveal on this plane uses. Bounded
  // detail: a count plus the claim ids, which are opaque CMD numbers and not PHI.
  await recordAccess({
    actorEmail: actor.email,
    actorUserId: actor.userId,
    action: 'read_ar_queue_notes',
    detail: { claims: pairs.length, cmd_claim_ids: pairs.slice(0, 200).map((p) => p.cmdClaimId), entities: entityIds.length },
  });
  const q = buildArLatestNotesQuery(pairs, entityIds);
  const { rows } = await arExecutor().query<ArLatestNoteEncRow>(q.sql, q.params);
  const out: Record<string, ArLatestNote> = {};
  for (const r of rows) {
    let text: string;
    try {
      text = await decryptPhi(Buffer.from(r.note_enc));
    } catch {
      text = '[note could not be decrypted]';
    }
    out[r.cmd_claim_id] = {
      text,
      noted_at: r.noted_at,
      author: r.author_label,
      source: r.source === 'user' ? 'user' : 'cmd',
      claim_level: r.claim_level === true,
    };
  }
  return out;
}

/** Reveal ONE patient — audit row FIRST (id-only detail), then decrypt. */
export async function revealArPatient(cmdPatientId: string, actor: ArActor, entityIds: string[]): Promise<ArRevealedPatient | null> {
  await recordAccess({ actorEmail: actor.email, actorUserId: actor.userId, action: 'reveal_ar_patient', detail: { cmd_patient_id: cmdPatientId, entities: entityIds.length } });
  const q = buildArPatientRevealQuery(cmdPatientId, entityIds);
  const { rows } = await arExecutor().query<{ patient_name_enc: Buffer; patient_dob_enc: Buffer | null; member_id_enc: Buffer | null }>(q.sql, q.params);
  const r = rows[0];
  if (!r) return null;
  const [name, dob, member] = await Promise.all([
    decryptPhi(Buffer.from(r.patient_name_enc)),
    r.patient_dob_enc ? decryptPhi(Buffer.from(r.patient_dob_enc)) : Promise.resolve(null),
    r.member_id_enc ? decryptPhi(Buffer.from(r.member_id_enc)) : Promise.resolve(null),
  ]);
  return { patient_name: name, patient_dob: dob, member_id: member };
}

/** Bulk reveal for the "Reveal all" toggle — ONE audit row naming the count, then decrypt. */
export async function revealArPatients(cmdPatientIds: string[], actor: ArActor, entityIds: string[]): Promise<Array<{ cmd_patient_id: string; patient_name: string; member_id: string | null }>> {
  await recordAccess({ actorEmail: actor.email, actorUserId: actor.userId, action: 'reveal_ar_rows', detail: { patients: cmdPatientIds.length, entities: entityIds.length } });
  const q = buildArPatientsRevealQuery(cmdPatientIds, entityIds);
  const { rows } = await arExecutor().query<{ cmd_patient_id: string; patient_name_enc: Buffer; member_id_enc: Buffer | null }>(q.sql, q.params);
  return Promise.all(
    rows.map(async (r) => ({
      cmd_patient_id: r.cmd_patient_id,
      patient_name: await decryptPhi(Buffer.from(r.patient_name_enc)),
      member_id: r.member_id_enc ? await decryptPhi(Buffer.from(r.member_id_enc)) : null,
    })),
  );
}

export interface ArAssignee { user_id: string; email: string; role: string; entity: string | null }

/** Look an assignee up by uuid — the mutation validates role + tenant against THIS, not the client. */
export async function resolveArAssignee(userId: string): Promise<ArAssignee | null> {
  const q = buildArAssigneeLookupQuery(userId);
  const { rows } = await arExecutor().query<ArAssignee>(q.sql, q.params);
  return rows[0] ?? null;
}

/** Add an in-app note: encrypt here, insert via the definer (server-resolved actor), bust the cache. */
export async function addArNote(actor: ArActor, entityId: string, cmdClaimId: string, text: string): Promise<void> {
  const enc = await encryptPhi(text);
  await arExecutor().query('select claims.ar_add_note($1::uuid, $2, $3::uuid, $4, $5::bytea) as id', [actor.userId, actor.email, entityId, cmdClaimId, enc]);
  revalidateTag(AR_CACHE_TAG);
}

/** Set the work disposition via the definer; events are written inside it. */
export async function setArWork(actor: ArActor, entityId: string, cmdClaimId: string, patch: ArWorkPatch): Promise<void> {
  await arExecutor().query(
    'select claims.ar_set_work($1::uuid, $2, $3::uuid, $4, $5, $6::uuid, $7, $8::date, $9)',
    [actor.userId, actor.email, entityId, cmdClaimId, patch.workStatus, patch.assigneeUserId, patch.assigneeEmail, patch.dueOn, patch.resolutionCode],
  );
  revalidateTag(AR_CACHE_TAG);
}

export async function loadArNotifications(userId: string, entityIds: string[]): Promise<ArNotificationsPayload> {
  const exec = arExecutor();
  const l = buildArNotificationsQuery(userId, entityIds);
  const c = buildArNotificationCountQuery(userId, entityIds);
  const [items, count] = await Promise.all([exec.query<Row>(l.sql, l.params), exec.query<{ unread: number }>(c.sql, c.params)]);
  return {
    unread: Number(count.rows[0]?.unread ?? 0),
    items: items.rows.map((r) => ({ ...(r as unknown as ArNotificationRow), id: Number(r.id), unread: r.unread === true })),
  };
}

export async function markArNotificationsSeen(userId: string): Promise<void> {
  await arExecutor().query('select claims.ar_mark_notifications_seen($1::uuid)', [userId]);
}
