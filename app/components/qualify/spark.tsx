/**
 * Qualify sparkline — a pure, dependency-free SVG line (both surfaces). Draws itself on mount via the
 * `.q-spark path.ln` stroke-dashoffset animation (globals.css `q-draw`), fully drawn under
 * prefers-reduced-motion (the global reset force-sets offset 0). Decorative: aria-hidden; the number
 * it accompanies is the accessible value. NO React hooks — renders hermetically under
 * renderToStaticMarkup. Points are ratings (0-100), oldest→newest; fewer than 2 points renders
 * nothing (a one-point "line" would fabricate a trend).
 */

/** Deterministic gradient id from the color + points (stable across renders, unique enough per card). */
function gradientId(hex: string, points: readonly number[]): string {
  return `qs-${hex.replace('#', '')}-${points.length}-${Math.round((points[0] ?? 0) * 10)}-${Math.round((points[points.length - 1] ?? 0) * 10)}`;
}

export function Spark({
  points,
  hex,
  width = 232,
  height = 32,
}: {
  points: readonly number[];
  hex: string;
  width?: number;
  height?: number;
}) {
  if (points.length < 2) return null;
  const min = Math.min(...points);
  const max = Math.max(...points);
  const range = max - min || 1;
  const coords = points.map((v, i) => [
    (i / (points.length - 1)) * width,
    height - 4 - ((v - min) / range) * (height - 8),
  ]);
  const d = coords.map(([x, y], i) => `${i ? 'L' : 'M'}${x!.toFixed(1)} ${y!.toFixed(1)}`).join(' ');
  const id = gradientId(hex, points);
  return (
    <svg
      aria-hidden
      className="q-spark block"
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      fill="none"
    >
      <defs>
        <linearGradient id={id} x1="0" y1="0" x2="1" y2="0">
          <stop offset="0" stopColor={hex} stopOpacity="0.25" />
          <stop offset="1" stopColor={hex} stopOpacity="1" />
        </linearGradient>
      </defs>
      <path className="ln" d={d} stroke={`url(#${id})`} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
