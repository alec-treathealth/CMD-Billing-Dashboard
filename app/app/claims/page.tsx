/**
 * Claims route — TEMPORARILY TAKEN DOWN (2026-07-15, Alec: "remove the claims tab entirely;
 * take it down from the app for right now"). The Claims Explorer is NOT deleted — its full
 * implementation (this page + the [claimId] detail + <ClaimsExplorer> / <ClaimReveal> / getClaim)
 * lives in git history. To restore: revert this file + ../claims/[claimId]/page.tsx to their
 * pre-2026-07-15 versions and re-add the nav link in components/nav-links.tsx. "Claims" remains
 * reserved for future Veris S10.
 */
import { redirect } from 'next/navigation';

export default function ClaimsPage() {
  redirect('/');
}
