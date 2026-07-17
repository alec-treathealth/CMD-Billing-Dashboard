/**
 * Alec-only user logs. Shows the durable `claims.access_audit` trail: staff actor, action,
 * timestamp, and non-PHI detail metadata. This page is hard-gated server-side to Alec's signed-in
 * app account; it is not a general admin surface.
 */
import type { Metadata } from 'next';
import Link from 'next/link';
import { redirect } from 'next/navigation';
import { Button, buttonVariants } from '@/components/ui/button';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { dashboardAccess } from '@/lib/access';
import { isAlecOwnerEmail } from '@/lib/alec-only';
import { loadUserLogs, parseUserLogSearchParams, type UserLogFilters } from '@/lib/user-log-actions';

export const metadata: Metadata = { title: 'User Logs | CMD Billing' };

const dtf = new Intl.DateTimeFormat('en-US', {
  dateStyle: 'medium',
  timeStyle: 'short',
  timeZone: 'America/Los_Angeles',
});

function first(value: string | string[] | undefined): string {
  return Array.isArray(value) ? value[0] ?? '' : value ?? '';
}

function pageHref(filters: UserLogFilters, page: number): string {
  const params = new URLSearchParams();
  if (filters.actorEmail) params.set('actor', filters.actorEmail);
  if (filters.action) params.set('action', filters.action);
  if (filters.fromDate) params.set('from', filters.fromDate);
  if (filters.toDate) params.set('to', filters.toDate);
  if (page > 1) params.set('page', String(page));
  const qs = params.toString();
  return qs ? `/admin/user-logs?${qs}` : '/admin/user-logs';
}

function formatTime(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : `${dtf.format(d)} PT`;
}

function detailText(detail: Record<string, unknown>): string {
  const keys = Object.keys(detail);
  return keys.length === 0 ? '—' : JSON.stringify(detail);
}

export default async function UserLogsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const access = await dashboardAccess();
  if (!access.ok) {
    if (access.reason === 'unauthenticated') redirect('/login');
    redirect('/dashboard');
  }
  if (!isAlecOwnerEmail(access.access.user?.email)) redirect('/dashboard');

  const rawParams = await searchParams;
  const filters = parseUserLogSearchParams(rawParams);
  const result = await loadUserLogs(filters);
  const page = result.ok ? result.page : Math.max(1, Math.trunc(Number(first(rawParams.page)) || 1));
  const totalPages = result.ok ? Math.max(1, Math.ceil(result.total / result.pageSize)) : 1;

  return (
    <main className="mx-auto max-w-6xl space-y-6 p-6 sm:p-10">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">User logs</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Alec-only activity log from <span className="font-mono">claims.access_audit</span>. Detail values are
          non-PHI operational metadata only.
        </p>
      </header>

      <form className="rounded-lg border border-line bg-card p-4 shadow-ths" action="/admin/user-logs">
        <div className="grid gap-3 md:grid-cols-[1.4fr_1fr_1fr_1fr_auto] md:items-end">
          <label className="flex flex-col gap-1 text-[11px] font-semibold uppercase tracking-wide text-ink400">
            Actor email
            <input
              name="actor"
              defaultValue={first(rawParams.actor)}
              placeholder="name@company.com"
              className="h-9 rounded-md border border-line bg-card px-2 text-[13px] font-normal normal-case text-ink900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--brand-accent)]"
            />
          </label>
          <label className="flex flex-col gap-1 text-[11px] font-semibold uppercase tracking-wide text-ink400">
            Action
            <input
              name="action"
              defaultValue={first(rawParams.action)}
              placeholder="reveal_cmd_rows"
              className="h-9 rounded-md border border-line bg-card px-2 text-[13px] font-normal normal-case text-ink900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--brand-accent)]"
            />
          </label>
          <label className="flex flex-col gap-1 text-[11px] font-semibold uppercase tracking-wide text-ink400">
            From
            <input
              type="date"
              name="from"
              defaultValue={first(rawParams.from)}
              className="h-9 rounded-md border border-line bg-card px-2 text-[13px] font-normal normal-case text-ink900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--brand-accent)]"
            />
          </label>
          <label className="flex flex-col gap-1 text-[11px] font-semibold uppercase tracking-wide text-ink400">
            To
            <input
              type="date"
              name="to"
              defaultValue={first(rawParams.to)}
              className="h-9 rounded-md border border-line bg-card px-2 text-[13px] font-normal normal-case text-ink900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--brand-accent)]"
            />
          </label>
          <div className="flex gap-2">
            <Button type="submit" size="sm">Filter</Button>
            <Link className={buttonVariants({ size: 'sm', variant: 'outline' })} href="/admin/user-logs">
              Reset
            </Link>
          </div>
        </div>
      </form>

      {!result.ok ? (
        <div className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {result.error}
        </div>
      ) : (
        <section className="space-y-3">
          <div className="flex items-center justify-between text-sm text-muted-foreground">
            <span>{result.total.toLocaleString()} log row{result.total === 1 ? '' : 's'}</span>
            <span>Page {page} of {totalPages}</span>
          </div>
          <div className="overflow-x-auto rounded-md border bg-surface">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="min-w-44">Time</TableHead>
                  <TableHead>Actor</TableHead>
                  <TableHead>Action</TableHead>
                  <TableHead>Detail</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {result.rows.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={4} className="py-10 text-center text-sm text-muted-foreground">
                      No log rows match these filters.
                    </TableCell>
                  </TableRow>
                ) : (
                  result.rows.map((row) => (
                    <TableRow key={row.id} className="align-top">
                      <TableCell className="whitespace-nowrap text-sm text-ink900">{formatTime(row.createdAt)}</TableCell>
                      <TableCell>
                        <div className="text-sm text-ink900">{row.actorEmail}</div>
                        <div className="mt-0.5 max-w-40 truncate font-mono text-[11px] text-ink400" title={row.actorUserId}>
                          {row.actorUserId}
                        </div>
                      </TableCell>
                      <TableCell className="whitespace-nowrap font-mono text-xs text-ink900">{row.action}</TableCell>
                      <TableCell className="max-w-[36rem] break-words font-mono text-xs text-ink700">
                        {detailText(row.detail)}
                      </TableCell>
                    </TableRow>
                  ))
                )}
              </TableBody>
            </Table>
          </div>
          <div className="flex justify-end gap-2">
            <Link
              aria-disabled={page <= 1}
              className={buttonVariants({
                size: 'sm',
                variant: 'outline',
                className: page <= 1 ? 'pointer-events-none opacity-50' : undefined,
              })}
              href={pageHref(filters, Math.max(1, page - 1))}
            >
              Previous
            </Link>
            <Link
              aria-disabled={page >= totalPages}
              className={buttonVariants({
                size: 'sm',
                variant: 'outline',
                className: page >= totalPages ? 'pointer-events-none opacity-50' : undefined,
              })}
              href={pageHref(filters, Math.min(totalPages, page + 1))}
            >
              Next
            </Link>
          </div>
        </section>
      )}
    </main>
  );
}
