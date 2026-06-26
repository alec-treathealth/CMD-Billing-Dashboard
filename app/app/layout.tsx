import type { Metadata } from 'next';
import { NavLinks } from '@/components/nav-links';
import { signOut } from '@/lib/auth-actions';
import { createSupabaseServerClient } from '@/lib/supabase/server';
import { supabaseAuthConfigured } from '@/lib/supabase/env';
import './globals.css';

export const metadata: Metadata = {
  title: 'Claims Search',
  description: 'Historical out-of-network behavioral-health claims search (PHI — compliance layer on).',
};

/** TreatHealthOS hexagon mark (teal/coral facets), inline so the shell needs no asset. */
function Logo({ size = 26 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 100 100" aria-label="TreatHealthOS">
      <polygon
        points="50,4 88,26 88,74 50,96 12,74 12,26"
        fill="rgba(255,255,255,.08)"
        stroke="#fff"
        strokeWidth="5"
      />
      <polygon points="50,20 68,31 50,42 32,31" fill="#1C8B82" />
      <polygon points="68,31 68,53 50,64 50,42" fill="#135E5A" />
      <polygon points="50,42 50,64 32,53 32,31" fill="#E2674F" />
      <polygon points="50,64 66,73 50,82 34,73" fill="#F0917C" />
    </svg>
  );
}

/** Sign-out — a server-action form button (no client JS). Shown only when signed in. */
function SignOutButton() {
  return (
    <form action={signOut}>
      <button
        type="submit"
        className="rounded-md bg-white/10 px-3 py-1.5 text-[13px] font-medium text-white/80 ring-1 ring-white/20 transition-colors hover:bg-white/20 hover:text-white"
      >
        Sign out
      </button>
    </form>
  );
}

/** Cheap session-presence check for nav (cookie read only; the real gate is middleware). */
async function isSignedIn(): Promise<boolean> {
  if (!supabaseAuthConfigured()) return false;
  try {
    const supabase = await createSupabaseServerClient();
    const {
      data: { session },
    } = await supabase.auth.getSession();
    return Boolean(session);
  } catch {
    return false;
  }
}

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const signedIn = await isSignedIn();
  return (
    <html lang="en">
      <body className="min-h-screen bg-ground">
        {/* teal900 anchor bar — 3-col grid keeps the nav centered while the logo
            stays left and the right column holds the sign-out action */}
        <header className="grid h-14 grid-cols-[auto_1fr_auto] items-center gap-3 bg-teal900 px-4 sm:px-6">
          {/* col 1: logo + title */}
          <div className="flex items-center gap-3">
            <Logo size={26} />
            <div className="leading-none">
              <div className="ths-h text-sm font-semibold tracking-tight text-white">Claims Search</div>
              <div className="mt-0.5 hidden text-[9px] font-semibold tracking-widest text-white/70 sm:block">
                TREAT MENTAL HEALTH · BILLING &amp; RCM
              </div>
            </div>
          </div>
          {/* col 2: nav — centered */}
          <NavLinks />
          {/* col 3: sign-out when authenticated (keeps nav centered otherwise) */}
          <div className="flex items-center justify-end">
            {signedIn ? <SignOutButton /> : null}
          </div>
        </header>
        {children}
      </body>
    </html>
  );
}
