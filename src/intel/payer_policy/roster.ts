/**
 * Payer roster. allowed_domains and payer scope are ONE UNIT — a call's domain
 * filter must never be narrower than the queries it issues, or the model will
 * attribute one payer's policy to another and every source_url will still pass
 * the provenance gate. That failure mode is silent, which is why the roster
 * couples them in a single record and `run.ts` never accepts a domain list
 * separately.
 *
 * Bare domains match subdomains, so entries use the provider subdomain rather
 * than the parent: `anthem.com` drags in consumer eoc/sbc/findcare pages.
 * sec.gov is deliberately excluded — it burns searches on 8-Ks.
 *
 * Federal work is its own key (two of them). Measured on the 2026-08-03 batch:
 * with CMS + Federal Register + AMA + NUBC sharing one 15-search budget, OPPS and
 * PFS consumed all of it — ama-assn.org returned 1 URL of 150, nubc.org returned
 * 0, and the run logged NUBC and NSA/IDR as never queried. Federal findings are
 * also identical for every payer, so folding them into each payer key paid for
 * the same research once per payer (5 of 10 findings in that batch).
 *
 * Budgets raised 2026-08-03 (federal search 20->28, payer search 10->14, fetch
 * 6->10) because `budget_exhausted` was 28 of 40 unreachable rows on run 2 —
 * 70% of unreachables were our own caps, only 4 of 40 were permanently
 * login-gated. Both measured runs used their caps exactly (98/98 search, 56/56
 * fetch), so raising them WILL raise cost: ~97% of the ~$38-40/run cost is
 * input tokens driven by fetched PDFs, which `max_content_tokens` does not
 * bound — expect roughly $55-65/run at these caps. Re-measure with
 * `DRY_RUN=1 npx tsx scripts/run_payer_intel.ts` before trusting a new number.
 */

export type Tier = 1 | 2 | 3 | 4;

export interface RosterEntry {
  key: string;
  display: string;
  /** Both the web_search and web_fetch domain filter for this key. */
  domains: string[];
  tier: Tier;
  searchUses: number;
  fetchUses: number;
}

export const ROSTER: readonly RosterEntry[] = [
  {
    key: 'federal',
    display: 'Federal rules and rates — CMS and the Federal Register. Industry-wide changes only, no single payer.',
    domains: ['cms.gov', 'federalregister.gov'],
    tier: 1, searchUses: 28, fetchUses: 8,
  },
  {
    key: 'codesets',
    display: 'Code-set governance bodies — AMA (CPT) and NUBC (UB-04 revenue codes). Industry-wide code-set changes only, no single payer.',
    domains: ['ama-assn.org', 'nubc.org'],
    tier: 2, searchUses: 8, fetchUses: 10,
  },
  {
    key: 'optum',
    display: 'Optum / UnitedHealthcare Behavioral Health (Provider Express)',
    domains: ['public.providerexpress.com', 'uhcprovider.com'],
    tier: 1, searchUses: 14, fetchUses: 10,
  },
  {
    key: 'anthem',
    display: 'Anthem',
    domains: ['providernews.anthem.com', 'providers.anthem.com'],
    tier: 1, searchUses: 14, fetchUses: 10,
  },
  {
    key: 'cigna',
    display: 'Cigna / Evernorth',
    domains: ['providernewsroom.com/evernorth', 'cigna.com', 'evernorth.com'],
    tier: 1, searchUses: 14, fetchUses: 10,
  },
  {
    key: 'aetna',
    display: 'Aetna',
    domains: ['aetna.com', 'meritain.com'],
    tier: 2, searchUses: 14, fetchUses: 10,
  },
  {
    key: 'umr',
    display: 'UMR',
    domains: ['umr.com'],
    tier: 3, searchUses: 14, fetchUses: 10,
  },
  {
    key: 'bsca',
    display: 'Blue Shield of California',
    domains: ['blueshieldca.com'],
    tier: 3, searchUses: 14, fetchUses: 10,
  },
  {
    key: 'bcbstx',
    display: 'Blue Cross Blue Shield of Texas',
    domains: ['bcbstx.com'],
    tier: 4, searchUses: 14, fetchUses: 10,
  },
] as const;

export function rosterEntry(key: string): RosterEntry | undefined {
  return ROSTER.find((r) => r.key === key);
}

export function rosterKeys(): string[] {
  return ROSTER.map((r) => r.key);
}

const MULTIPART_SUFFIXES = new Set([
  'co.uk', 'org.uk', 'ac.uk', 'gov.uk', 'com.au', 'co.nz', 'co.jp', 'com.br', 'co.za',
]);

/**
 * Normalizes a hostname for comparison: lowercase, and strip the DNS root label.
 *
 * `new URL().hostname` PRESERVES a trailing dot, so `www.uhcprovider.com.` and
 * `www.uhcprovider.com` are the same host but compare unequal. Observed live: the
 * search tool returned `https://www.uhcprovider.com./` once in 106 URLs, which
 * failed the domain gate and marked an otherwise-healthy run FAILED.
 *
 * Against an allow-list this gap fails CLOSED (rejects valid, never admits
 * invalid). The same gap against a block-list would be a filter-bypass vector, so
 * normalization lives in one place both callers share rather than being inlined.
 */
function normalizeHost(hostname: string): string {
  return hostname.toLowerCase().replace(/\.+$/, '');
}

/** eTLD+1 approximation. Adequate for this roster (.com/.gov/.org); the multipart
 *  set keeps a stray foreign URL grouping sanely rather than collapsing to a TLD. */
export function registrableDomain(hostname: string): string {
  const parts = normalizeHost(hostname).replace(/^www\./, '').split('.');
  if (parts.length <= 2) return parts.join('.');
  const lastTwo = parts.slice(-2).join('.');
  return MULTIPART_SUFFIXES.has(lastTwo) ? parts.slice(-3).join('.') : lastTwo;
}

/**
 * `allowed_domains` semantics: a bare domain matches itself and all subdomains;
 * an entry carrying a path additionally requires that path prefix (which is how
 * `providernewsroom.com/evernorth` stays scoped to Evernorth).
 */
export function matchesDomainEntry(url: string, entry: string): boolean {
  const slash = entry.indexOf('/');
  const entryHost = normalizeHost(slash === -1 ? entry : entry.slice(0, slash));
  const entryPath = slash === -1 ? '' : entry.slice(slash);
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;
  const host = normalizeHost(parsed.hostname);
  if (host !== entryHost && !host.endsWith(`.${entryHost}`)) return false;
  return entryPath === '' || parsed.pathname.startsWith(entryPath);
}

export function matchesAnyDomain(url: string, entries: readonly string[]): boolean {
  return entries.some((entry) => matchesDomainEntry(url, entry));
}
