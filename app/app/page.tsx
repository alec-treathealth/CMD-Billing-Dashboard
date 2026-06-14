/**
 * Root route — redirects to the dashboard overview (Phase 7.3 split).
 *
 * The combined page (which mounted both <SearchConsole /> and <Dashboard />) was
 * split into /dashboard (aggregate overview) and /ask (AI search). The root now
 * sends visitors to the dashboard; the header nav links to both destinations.
 */
import { redirect } from 'next/navigation';

export default function Home() {
  redirect('/dashboard');
}
