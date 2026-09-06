/**
 * /admin/payer-aliases — the payer-alias RULING QUEUE (Artifact 2: read side only).
 *
 * Shows the 990 rows of `ref.payer_alias_map` that carry `needs_review`, with the context a
 * reviewer needs to rule on each one: the machine's proposal resolved through `ref.payer_identity`,
 * the 029 review note, the same string as ruled under the other vocabularies, and confirmed
 * trigram look-alikes. It ships ZERO writes — no confirm control, no relationship picker, no
 * definer, no audit row. The write chain is Artifact 3.
 *
 * ── GATE: super_admin, fail-closed ───────────────────────────────────────────────────────────────
 * `export const dynamic = 'force-dynamic'` is a SECURITY control, not a perf setting: without it the
 * role guard can be prerendered away at build time and the page ships as static HTML to anyone.
 * The registry (/qualify/registry) carries the identical line for the identical reason.
 *
 * `super_admin` rather than the facility-resolution `admin || super_admin`, and the reason is
 * structural: `ref.payer_alias_map` has NO tenancy column — its PK is (vocabulary, alias_norm) and
 * one ruling governs BXR and Indigo together, by ratified design. `admin` is an ENTITY-scoped role,
 * and there is no `business_entity_id` here to clamp it against, so an entity admin ruling here
 * would silently reach across a boundary their role otherwise stops at. There is no fail-closed
 * tenant check available to make `admin` safe on this surface.
 *
 * ⚠️ THE `access.user` CHECK IS NOT REDUNDANT WITH THE ROLE CHECK. `dashboardAccess()` returns a
 * staged-rollout fallback of role `super_admin` with `user: null` when Supabase auth is not
 * configured. Testing the role alone would hand this surface to an unauthenticated request in that
 * configuration. A real principal is required — the same order the registry uses.
 *
 * ── PHI ──────────────────────────────────────────────────────────────────────────────────────────
 * Non-PHI by construction (payer names, `pi_*` slugs, prose). Nothing is CSS-hidden because there is
 * no value to hide. `alias_norm` can hold an employer name, so it is never placed in a URL: the only
 * route values this page reads or writes are the vocabulary enum (`v`) and an integer page (`p`).
 */
import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { dashboardAccess } from '@/lib/access';
import { loadPayerAliasQueue } from '@/lib/payer-alias/loaders';
import { clampPage, clampVocabulary } from '../../../../src/collections/payerAliasQueue';
import {
  Pager,
  QueueList,
  VOCAB_HINTS,
  VOCAB_LABELS,
  VocabularyTabs,
} from '@/components/admin/payer-alias-leaves';

export const metadata: Metadata = { title: 'Payer aliases | CMD Billing' };

/** SECURITY control — see the docblock. Do not remove to make the page cacheable. */
export const dynamic = 'force-dynamic';

function first(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

export default async function PayerAliasesPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const access = await dashboardAccess();
  if (!access.ok) {
    if (access.reason === 'unauthenticated') redirect('/login?next=%2Fadmin%2Fpayer-aliases');
    redirect('/dashboard'); // unprovisioned → no admin surface
  }
  // Real principal AND super_admin — the staged-rollout fallback has no user and must not pass.
  if (!access.access.user || access.access.role !== 'super_admin') redirect('/dashboard');

  const params = await searchParams;
  const vocabulary = clampVocabulary(first(params.v));
  const page = clampPage(first(params.p));

  const queue = await loadPayerAliasQueue(vocabulary, page);
  const total = queue.counts[vocabulary];

  return (
    <main className="mx-auto max-w-4xl space-y-6 p-6 sm:p-10">
      <header>
        <h1 className="font-display text-2xl font-semibold tracking-tight">Payer aliases</h1>
        <p className="mt-1 text-sm text-ink600">
          Raw payer strings awaiting a ruling. Confirming one sets the canonical payer it resolves
          to for <span className="font-medium">both tenants</span> — this crosswalk has no tenancy
          dimension by design.
        </p>
      </header>

      <VocabularyTabs active={vocabulary} counts={queue.counts} />

      <section aria-labelledby="queue-heading" className="space-y-3">
        <div>
          <h2 id="queue-heading" className="text-sm font-semibold text-ink900">
            {VOCAB_LABELS[vocabulary]}
          </h2>
          <p className="mt-0.5 text-xs text-ink600">{VOCAB_HINTS[vocabulary]}</p>
        </div>

        <QueueList rows={queue.rows} siblings={queue.siblings} neighbours={queue.neighbours} />

        {/* queue.page is already clamped to the real last page by the loader (M2); the Pager
            re-clamps defensively because it is an independently-renderable leaf. */}
        <Pager
          vocabulary={vocabulary}
          page={queue.page}
          pageSize={queue.pageSize}
          total={total}
          hasMore={queue.hasMore}
        />
      </section>

      <footer className="mt-10 border-t border-line pt-4 text-xs text-ink400">
        Read-only. Rulings are not yet writable from this screen. No PHI lives on this surface —
        payer names, payer identifiers and notes only.
      </footer>
    </main>
  );
}
