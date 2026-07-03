/**
 * Tenant → brand-mark map. The ONE place a tenant's logo is declared, so onboarding a new
 * tenant's mark (e.g. Indigo's real asset) is a single map entry — no new rendering logic.
 *
 * Keyed by the tenant SLUG, which is BOTH the RBAC `Entity` value and the non-consolidated
 * `DashboardView` value ('bxr' | 'indigo') — so the same key serves the avatar-side placement
 * (driven by the signed-in user's entity) and the switcher-side placement (driven by `?view=`).
 * 'consolidated' is intentionally NOT a key: there is no single tenant to brand, so the
 * consolidated super-admin view renders no tenant logo (tenantBrand() returns null for it).
 *
 * Pure + asset-only (no DB, no secrets, no session) → safe to import from Server or Client
 * Components.
 */
export type TenantSlug = 'bxr' | 'indigo';

export type TenantBrand =
  /** A real logo asset served from the app's static dir (app/public; Vercel app root is app/). */
  | { kind: 'image'; src: string; alt: string }
  /** Placeholder monogram (bar treatment, like the inline hexagon) until a real asset lands. */
  | { kind: 'initials'; initials: string; alt: string };

export const TENANT_BRANDING: Record<TenantSlug, TenantBrand> = {
  // Real asset supplied out-of-band into app/public/logos/bxr.png (do NOT commit-wire until present).
  bxr: { kind: 'image', src: '/logos/bxr.png', alt: 'BxR Consulting' },
  // No real Indigo asset yet → initials placeholder; swap to { kind: 'image', src, alt } when it lands.
  indigo: { kind: 'initials', initials: 'IB', alt: 'Indigo Billing' },
};

/** Resolve a slug (an entity or a non-consolidated view) to its brand, or null if none/consolidated. */
export function tenantBrand(slug: string | null | undefined): TenantBrand | null {
  if (slug === 'bxr' || slug === 'indigo') return TENANT_BRANDING[slug];
  return null;
}
