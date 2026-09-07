'use client';

import { SpeedInsights as VercelSpeedInsights } from '@vercel/speed-insights/next';

/**
 * Vercel Speed Insights (Core Web Vitals), with the query string stripped BEFORE egress.
 *
 * ┌─ WHY THIS WRAPPER EXISTS (do not import the Vercel component directly) ────────────────────────┐
 * │ The vitals beacon carries the FULL HREF, not just the computed route. The npm package only     │
 * │ builds a `route` label (computeRoute → /claims/[claimId]) and writes it to a script dataset;   │
 * │ the actual send is done by the remote /_vercel/speed-insights/script.js, which is NOT in       │
 * │ node_modules and cannot be pinned or inspected. Its payload contract is visible in the shipped │
 * │ types: `BeforeSendEvent { type; url: string; route?: string }` — `url` REQUIRED, `route`       │
 * │ optional. So reading computeRoute and concluding "the query string never leaves" is reading    │
 * │ the wrong half of the transmit path.                                                           │
 * │                                                                                                │
 * │ This app's URLs carry ?facility=<rehab>&payer=<carrier> (Qualify) and ?actor=<staff email>     │
 * │ (admin/user-logs). lib/qualify/urlState.ts's P0-4 header rules exactly that facility+payer     │
 * │ combination out of "history/Referer/edge logs" as a re-identification vector on an OON book.   │
 * │ Speed Insights is a NEW egress channel for it, so the same ruling applies here.                │
 * │                                                                                                │
 * │ beforeSend is the only lever we control over that remote script. Strip the WHOLE search + hash │
 * │ rather than allowlisting keys — an allowlist rots the moment someone adds a param, and the     │
 * │ route label (which is what the metric is actually keyed on) is unaffected by the strip.        │
 * │ Returning null instead would drop the datapoint entirely; we want the metric, minus the query. │
 * └────────────────────────────────────────────────────────────────────────────────────────────────┘
 *
 * `debug={false}`: the package loads a remote script.debug.js and console-logs each payload when
 * NODE_ENV is development/test. No PHI rides a URL today, but "PHI never reaches logs" is a
 * standing rule and a debug beacon printing hrefs in a PHI app is the wrong default.
 *
 * No <Suspense> needed at the call site: the package's Next entrypoint already wraps its own
 * useSearchParams() reader in one (dist/next/index.mjs — `createElement(Suspense, …)`).
 */
/**
 * Strip the query string and fragment from a vitals href. Exported PURE so the invariant is
 * asserted in test/speed-insights-scrub.test.tsx rather than assumed of a remote script.
 * Returns null for an unparseable href — drop the datapoint rather than forward it unscrubbed.
 */
export function scrubVitalsUrl(href: string): string | null {
  try {
    const url = new URL(href);
    url.search = '';
    url.hash = '';
    return url.toString();
  } catch {
    return null;
  }
}

export function SpeedInsights() {
  return (
    <VercelSpeedInsights
      debug={false}
      beforeSend={(event) => {
        const url = scrubVitalsUrl(event.url);
        return url === null ? null : { ...event, url };
      }}
    />
  );
}
