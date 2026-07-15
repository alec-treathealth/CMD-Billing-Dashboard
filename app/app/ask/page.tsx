/**
 * Ask route — REMOVED FROM THE APP 2026-07-15 (Alec: unfinished, doesn't do anything). The NL
 * claims-search console (<SearchConsole /> + the /api/agent path) is NOT deleted — its
 * implementation stays in git history; restore this page (mount <SearchConsole />) and re-add the
 * nav link in components/nav-links.tsx to bring it back. Redirects to home so /ask isn't reachable.
 */
import { redirect } from 'next/navigation';

export default function AskPage() {
  redirect('/');
}
