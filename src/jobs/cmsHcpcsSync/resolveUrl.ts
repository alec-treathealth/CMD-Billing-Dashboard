/**
 * PURE resolver for the latest CMS quarterly HCPCS ZIP URL. No network I/O here —
 * takes the quarterly-update page HTML and returns the newest file link.
 *
 * WHY scrape instead of construct the filename: CMS filenames are NOT perfectly
 * regular. Most are `<month>-<year>-alpha-numeric-hcpcs-file.zip`, but some quarters
 * used the plural `...-hcpcs-files.zip` (e.g. Oct 2023, Jan/Apr 2024). Constructing a
 * URL by pattern (the original draft's approach) 404s on those quarters and on the
 * exact posting-date boundary. Parsing the authoritative listing is robust.
 *
 * Landing page:
 * https://www.cms.gov/medicare/coding-billing/healthcare-common-procedure-system/quarterly-update
 */

const MONTH_ORDER: Record<string, number> = {
  january: 1, april: 4, july: 7, october: 10,
};

export interface QuarterlyFileLink {
  url: string;
  month: string;
  year: number;
  /** Sort key: year * 100 + month, higher = newer. */
  rank: number;
}

const LINK_RE =
  /https?:\/\/www\.cms\.gov\/files\/zip\/(january|april|july|october)-(\d{4})-alpha-numeric-hcpcs-files?\.zip/gi;

/** Extract every quarterly file link found in the page HTML (deduped). */
export function extractQuarterlyFileLinks(html: string): QuarterlyFileLink[] {
  const seen = new Set<string>();
  const links: QuarterlyFileLink[] = [];
  for (const m of html.matchAll(LINK_RE)) {
    const url = m[0];
    if (seen.has(url)) continue;
    seen.add(url);
    const month = (m[1] ?? '').toLowerCase();
    const year = Number(m[2]);
    const monthNum = MONTH_ORDER[month] ?? 0;
    links.push({ url, month, year, rank: year * 100 + monthNum });
  }
  return links;
}

/**
 * Pick the newest quarterly file NOT effective after `asOf` (so a run doesn't grab a
 * future quarter that happens to be posted early — we sync the currently-effective
 * quarter). Returns null if none found.
 */
export function resolveLatestQuarterlyFile(
  html: string,
  asOf: Date = new Date(),
): QuarterlyFileLink | null {
  const links = extractQuarterlyFileLinks(html);
  if (links.length === 0) return null;

  const asOfRank = asOf.getUTCFullYear() * 100 + (asOf.getUTCMonth() + 1);
  const effective = links.filter((l) => l.rank <= asOfRank);
  const pool = effective.length > 0 ? effective : links;
  return pool.reduce((best, l) => (l.rank > best.rank ? l : best));
}

/** Derive a stable source_ref (e.g. "july-2026") for idempotency + provenance. */
export function sourceRefFromLink(link: QuarterlyFileLink): string {
  return `${link.month}-${link.year}`;
}
