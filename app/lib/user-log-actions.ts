/**
 * Alec-only user-log loader. This is the ONLY app path that reads `claims.access_audit` rows.
 * It requires a real signed-in app principal whose verified email is Alec's email; the no-auth
 * staged-rollout fallback has no user and is denied. The rows are non-PHI operational audit metadata.
 */
import { dashboardAccess } from '@/lib/access';
import { isAlecOwnerEmail } from '@/lib/alec-only';
import { listAccessAudit, type AccessAuditRow } from '@/lib/server';

export interface UserLogFilters {
  actorEmail?: string | null;
  action?: string | null;
  fromDate?: string | null;
  toDate?: string | null;
  page?: number;
}

export type UserLogResult =
  | { ok: true; rows: AccessAuditRow[]; total: number; page: number; pageSize: number }
  | { ok: false; reason: 'unauthorized' | 'unavailable'; error: string };

const PAGE_SIZE = 50;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function cleanText(value: string | null | undefined): string | null {
  const v = value?.trim();
  return v ? v : null;
}

function startOfUtcDate(value: string | null | undefined): string | null {
  if (!value || !DATE_RE.test(value)) return null;
  return `${value}T00:00:00.000Z`;
}

function exclusiveEndOfUtcDate(value: string | null | undefined): string | null {
  if (!value || !DATE_RE.test(value)) return null;
  const d = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(d.getTime())) return null;
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString();
}

function pageNumber(value: number | undefined): number {
  if (!Number.isFinite(value)) return 1;
  return Math.max(1, Math.trunc(value as number));
}

export function parseUserLogSearchParams(params: Record<string, string | string[] | undefined>): UserLogFilters {
  const scalar = (key: string): string | undefined => {
    const value = params[key];
    return Array.isArray(value) ? value[0] : value;
  };
  const page = Number(scalar('page'));
  return {
    actorEmail: cleanText(scalar('actor')),
    action: cleanText(scalar('action')),
    fromDate: cleanText(scalar('from')),
    toDate: cleanText(scalar('to')),
    page: Number.isFinite(page) ? page : 1,
  };
}

export async function loadUserLogs(filters: UserLogFilters): Promise<UserLogResult> {
  const access = await dashboardAccess();
  if (!access.ok || !isAlecOwnerEmail(access.access.user?.email)) {
    return { ok: false, reason: 'unauthorized', error: 'You do not have access to this page.' };
  }

  const page = pageNumber(filters.page);
  try {
    const result = await listAccessAudit({
      limit: PAGE_SIZE,
      offset: (page - 1) * PAGE_SIZE,
      actorEmail: cleanText(filters.actorEmail),
      action: cleanText(filters.action),
      fromIso: startOfUtcDate(filters.fromDate),
      toIso: exclusiveEndOfUtcDate(filters.toDate),
    });
    return { ok: true, rows: result.rows, total: result.total, page, pageSize: PAGE_SIZE };
  } catch {
    return { ok: false, reason: 'unavailable', error: 'Could not load user logs right now.' };
  }
}
