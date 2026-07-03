/**
 * Tenant brand mark for the top bar. Renders the mapped logo for a tenant slug (see
 * tenant-branding.ts): either a real image asset (on a white circle, so a dark mark reads on the
 * dark brand bar) or an initials monogram placeholder in the bar's white-on-transparent treatment
 * (matching the inline hexagon). Returns null for an unbranded/absent slug — including the
 * consolidated view, which has no single tenant to brand.
 *
 * Pure presentational markup with no directive: it renders server-side (the avatar-side placement
 * in the layout) and also composes inside a Client Component (the switcher-side placement).
 */
import { tenantBrand } from '@/lib/tenant-branding';

export function TenantLogo({
  slug,
  size = 26,
}: {
  slug: string | null | undefined;
  size?: number;
}) {
  const brand = tenantBrand(slug);
  if (!brand) return null;

  if (brand.kind === 'image') {
    return (
      // eslint-disable-next-line @next/next/no-img-element -- tiny fixed static bar asset; no next/image pipeline here
      <img
        src={brand.src}
        alt={brand.alt}
        title={brand.alt}
        width={size}
        height={size}
        style={{ width: size, height: size }}
        className="shrink-0 rounded-full bg-white object-contain ring-1 ring-white/30"
      />
    );
  }

  return (
    <span
      role="img"
      aria-label={brand.alt}
      title={brand.alt}
      style={{ width: size, height: size }}
      className="flex shrink-0 items-center justify-center rounded-full bg-white/10 text-[10px] font-semibold tracking-tight text-white ring-1 ring-white/30"
    >
      {brand.initials}
    </span>
  );
}
