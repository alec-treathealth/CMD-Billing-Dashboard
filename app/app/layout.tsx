import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'Claims Search',
  description: 'Historical out-of-network behavioral-health claims search (PHI — compliance layer on).',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
