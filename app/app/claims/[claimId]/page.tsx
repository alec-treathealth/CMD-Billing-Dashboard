/**
 * Claim detail route — TEMPORARILY TAKEN DOWN with the Claims Explorer (2026-07-15, Alec).
 * Original NON-PHI claim-detail implementation (getClaim + <ClaimReveal>) is in git history;
 * restore alongside ../page.tsx and re-add the nav link in components/nav-links.tsx to bring
 * the Claims Explorer back.
 */
import { redirect } from 'next/navigation';

export default function ClaimDetailPage() {
  redirect('/');
}
