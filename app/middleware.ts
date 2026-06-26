/**
 * Next.js middleware: refresh the Supabase auth session on every request (except
 * static assets) and redirect unauthenticated users away from protected paths.
 * The authoritative executive-allowlist check is server-side (requireExecutive),
 * not here — see lib/supabase/middleware.ts.
 */
import type { NextRequest } from 'next/server';
import { updateSession } from '@/lib/supabase/middleware';

export async function middleware(request: NextRequest) {
  return updateSession(request);
}

export const config = {
  // Run on everything except Next internals and common static asset extensions.
  matcher: ['/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico)$).*)'],
};
