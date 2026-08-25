/**
 * The non-blocking pointer banner QUALIFY mounts above its content — "this is also in Payer Intel
 * now". Collections mounted it too until 2026-08-25, when its call site was removed; the
 * `from="collections"` copy below therefore has no caller left. Classes are the house Notice
 * pattern (search-console.tsx's local Notice, muted tone — documented canonical in
 * design-system.md §Notice banner; that component is not exported, so the classes are copied, not
 * imported). Server component: pure markup, no state.
 */
import Link from 'next/link';

export function PayerIntelPointerBanner({ from }: { from: 'collections' | 'qualify' }) {
  return (
    <div className="rounded-md border border-teal200 bg-teal50/60 px-3 py-2 text-sm text-ink600">
      {from === 'collections' ? 'The Collections search engine' : "Qualify's tickers and policy ratings"} now also
      {' '}live on the consolidated{' '}
      <Link
        href="/payer-intel"
        className="font-semibold text-teal700 underline underline-offset-2 hover:text-teal900"
      >
        Payer Intel
      </Link>{' '}
      tab. Nothing here is going away in this release.
    </div>
  );
}
