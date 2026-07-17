/**
 * Inline SVG icons for the Qualify mobile PWA — the exact paths from the approved prototype, with no
 * external icon dependency so the renderToStaticMarkup tests stay lean under tsx. Presentational only.
 */
import type { ReactNode } from 'react';

function Svg({ size = 16, color = 'currentColor', children }: { size?: number; color?: string; children: ReactNode }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {children}
    </svg>
  );
}

type IconProps = { size?: number; color?: string };

export const BuildingIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M6 22V4a1 1 0 0 1 1-1h9a1 1 0 0 1 1 1v18Z" />
    <path d="M6 12H4a1 1 0 0 0-1 1v8a1 1 0 0 0 1 1h2" />
    <path d="M18 9h2a1 1 0 0 1 1 1v11a1 1 0 0 1-1 1h-2" />
    <path d="M10 6h4" /><path d="M10 10h4" /><path d="M10 14h4" /><path d="M10 18h4" />
  </Svg>
);

export const TrendIcon = (p: IconProps) => (
  <Svg {...p}><polyline points="23 6 13.5 15.5 8.5 10.5 1 18" /><polyline points="17 6 23 6 23 12" /></Svg>
);

export const XIcon = (p: IconProps) => (
  <Svg {...p}><line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" /></Svg>
);

export const SearchIcon = (p: IconProps) => (
  <Svg {...p}><circle cx="11" cy="11" r="8" /><line x1="21" y1="21" x2="16.65" y2="16.65" /></Svg>
);

export const FlameIcon = (p: IconProps) => (
  <Svg {...p}><path d="M8.5 14.5A2.5 2.5 0 0 0 11 12c0-1.38-.5-2-1-3-1.072-2.143-.224-4.054 2-6 .5 2.5 2 4.9 4 6.5 2 1.6 3 3.5 3 5.5a7 7 0 1 1-14 0c0-1.153.433-2.294 1-3a2.5 2.5 0 0 0 2.5 2.5z" /></Svg>
);

export const RefreshIcon = (p: IconProps) => (
  <Svg {...p}><polyline points="23 4 23 10 17 10" /><polyline points="1 20 1 14 7 14" /><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15" /></Svg>
);
