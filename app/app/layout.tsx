import type { Metadata } from 'next';
import { NavLinks } from '@/components/nav-links';
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

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-screen bg-ground">
        {/* teal900 anchor bar */}
        <header className="flex h-14 items-center gap-3 bg-teal900 px-4 sm:px-6">
          <Logo size={26} />
          <div className="leading-none">
            <div className="ths-h text-sm font-semibold tracking-tight text-white">Claims Search</div>
            <div className="mt-0.5 text-[9px] font-semibold tracking-widest text-white/70">
              TREAT MENTAL HEALTH · BILLING &amp; RCM
            </div>
          </div>
          <NavLinks />
        </header>
        {children}
      </body>
    </html>
  );
}
