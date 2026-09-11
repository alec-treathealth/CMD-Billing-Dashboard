/**
 * AR Management — PURE presentational leaves. No state, no effects, no data access, so every one of
 * them renders identically under renderToStaticMarkup and in the browser; the hermetic suite locks
 * their markup (app/test/ar-leaves-render.test.tsx) without jsdom.
 *
 * Visual system: TreatHealthOS v1 tokens (Collections parity). The one addition is the AGE RAMP —
 * nine fixed colours running teal → amber → oxblood as a claim gets older. It is the tab's
 * signature: the same colour paints a band tile, the pill on a row, and the 3px rail down the
 * row's left edge, so age reads at a glance without a legend. Data-keyed colours are inline styles
 * (a Tailwind alpha-on-var class emits nothing — memory: tailwind-alpha-on-var-is-dead-css).
 */
import type { ArBandKey, ArDenialSummaryItem, ArWorkStatus } from '@/lib/ar/contract';
import { AR_BANDS } from '../../../../src/billingAudit/arBuckets';
import { WORK_STATUS_META } from '@/lib/ar/contract';

/** teal (fresh) → amber → red → oxblood (stale). Designed as one ramp; never reorder. */
export const BAND_COLOR: Readonly<Record<ArBandKey, string>> = {
  '0_30': '#1C8B82',
  '31_60': '#3D9077',
  '61_90': '#6E9464',
  '91_120': '#A38E45',
  '4_6mo': '#C9881E',
  '6_9mo': '#D2703B',
  '9_12mo': '#D3583A',
  '1_2yr': '#BE4238',
  '2yr_plus': '#7F2C29',
};

export function bandLabel(key: ArBandKey | null): string {
  return AR_BANDS.find((b) => b.key === key)?.short ?? '—';
}

const USD = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 2, maximumFractionDigits: 2 });
const USD0 = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });

/** `$1,234.56`; non-numeric → em dash. */
export function money(v: string | number | null | undefined): string {
  const n = typeof v === 'number' ? v : Number(v);
  return v === null || v === undefined || v === '' || !Number.isFinite(n) ? '—' : USD.format(n);
}

/** `$5.78M` / `$412K` / `$980` — for tiles where the digit count must stay stable. */
export function moneyCompact(v: string | number | null | undefined): string {
  const n = typeof v === 'number' ? v : Number(v);
  if (v === null || v === undefined || v === '' || !Number.isFinite(n)) return '—';
  const abs = Math.abs(n);
  if (abs >= 1_000_000) return `${n < 0 ? '-' : ''}$${(abs / 1_000_000).toFixed(abs >= 10_000_000 ? 1 : 2)}M`;
  if (abs >= 10_000) return `${n < 0 ? '-' : ''}$${Math.round(abs / 1000)}K`;
  return USD0.format(n);
}

/** Whole-number money for the hero (`$52,464,876`). */
export function moneyWhole(v: string | number | null | undefined): string {
  const n = typeof v === 'number' ? v : Number(v);
  return v === null || v === undefined || v === '' || !Number.isFinite(n) ? '—' : USD0.format(n);
}

/** `123d` under a year, `1.4y` beyond. */
export function ageText(days: number | null | undefined): string {
  if (days === null || days === undefined || !Number.isFinite(days) || days < 0) return '—';
  return days <= 365 ? `${Math.floor(days)}d` : `${(days / 365).toFixed(1)}y`;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** 'YYYY-MM-DD' (or an ISO instant) → 'Mar 1, 2026'. Deterministic (no locale, no timezone). */
export function shortDate(iso: string | null | undefined): string {
  if (!iso) return '—';
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  if (!m) return iso;
  return `${MONTHS[Number(m[2]) - 1] ?? m[2]} ${Number(m[3])}, ${m[1]}`;
}

/** 'Mar 1 – Mar 5, 2026' for a DOS range (same-day → one date). */
export function dateRange(from: string | null | undefined, to: string | null | undefined): string {
  if (!from) return '—';
  if (!to || to === from) return shortDate(from);
  const a = /^(\d{4})-(\d{2})-(\d{2})/.exec(from);
  const b = /^(\d{4})-(\d{2})-(\d{2})/.exec(to);
  if (!a || !b) return `${shortDate(from)} – ${shortDate(to)}`;
  const left = a[1] === b[1] ? `${MONTHS[Number(a[2]) - 1]} ${Number(a[3])}` : shortDate(from);
  return `${left} – ${shortDate(to)}`;
}

/** Relative age of an instant against `nowMs` (null on the server → the caller shows a date). */
export function relativeTime(iso: string | null | undefined, nowMs: number | null): string | null {
  if (!iso || nowMs === null) return null;
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return null;
  const d = Math.max(0, nowMs - t);
  const min = Math.floor(d / 60_000);
  if (min < 1) return 'just now';
  if (min < 60) return `${min}m ago`;
  const h = Math.floor(min / 60);
  if (h < 24) return `${h}h ago`;
  const days = Math.floor(h / 24);
  if (days < 60) return `${days}d ago`;
  return `${Math.floor(days / 30)}mo ago`;
}

// --- chips -----------------------------------------------------------------------------------

const STATUS: Readonly<Record<string, { label: string; fg: string; bg: string }>> = {
  PAID: { label: 'Paid', fg: '#2F7D57', bg: '#E7F1EA' },
  AT_PAYER: { label: 'At payer', fg: '#3A6B8A', bg: '#E7EEF4' },
  BALANCE_DUE_PATIENT: { label: 'Patient balance', fg: '#B0741F', bg: '#F6EEDF' },
  APPROVED_HIGHER: { label: 'Approved higher', fg: '#5B4B8A', bg: '#ECE8F5' },
  NEEDS_RENEGOTIATING: { label: 'Needs renegotiating', fg: '#B0741F', bg: '#F6EEDF' },
  ON_HOLD: { label: 'On hold', fg: '#6B7A78', bg: '#ECEFEE' },
  OTHER: { label: 'Other', fg: '#6B7A78', bg: '#ECEFEE' },
};

/** CMD status as a chip. `AT_PAYER` shows the payer; a hand-applied CMD status shows its own text. */
export function ArStatusChip({ statusRaw, statusCategory, statusPayer, cmdStatusText }: { statusRaw: string; statusCategory: string; statusPayer: string | null; cmdStatusText: string | null }) {
  const s = STATUS[statusCategory] ?? STATUS.OTHER!;
  const detail = statusCategory === 'AT_PAYER' ? statusPayer : cmdStatusText ?? (statusCategory === 'OTHER' ? statusRaw : null);
  return (
    <span className="inline-flex max-w-full items-center gap-1.5 rounded-full px-2 py-0.5 text-xs font-semibold" style={{ color: s.fg, backgroundColor: s.bg }} title={statusRaw}>
      <span aria-hidden className="h-1.5 w-1.5 shrink-0 rounded-full" style={{ backgroundColor: s.fg }} />
      <span className="shrink-0">{s.label}</span>
      {detail && detail !== s.label ? <span className="ths-num truncate text-xs font-medium opacity-80">{detail}</span> : null}
    </span>
  );
}

/** The age pill — the ramp colour + the compact band label. */
export function BandPill({ band, ageDays }: { band: ArBandKey | null; ageDays: number | null }) {
  if (band === null) return <span className="text-xs text-ink400">—</span>;
  const c = BAND_COLOR[band];
  return (
    <span className="inline-flex items-center gap-1.5 whitespace-nowrap rounded-full border px-2 py-0.5 text-xs font-semibold" style={{ color: c, borderColor: `${c}66`, backgroundColor: `${c}14` }} title={AR_BANDS.find((b) => b.key === band)?.label}>
      <span className="ths-num">{ageText(ageDays)}</span>
      <span className="opacity-80">{bandLabel(band)}</span>
    </span>
  );
}

const TONE: Readonly<Record<string, { fg: string; bg: string }>> = {
  muted: { fg: '#63756E', bg: '#F1F3F2' },
  info: { fg: '#3A6B8A', bg: '#E7EEF4' },
  warn: { fg: '#B0741F', bg: '#F6EEDF' },
  accent: { fg: '#5B4B8A', bg: '#ECE8F5' },
  ok: { fg: '#2F7D57', bg: '#E7F1EA' },
  neutral: { fg: '#6B7A78', bg: '#ECEFEE' },
};

/**
 * `derived` = the state came from CMD's snapshot, not from a person (migration 0113). It renders as
 * an OUTLINE rather than a filled chip, so the queue never presents a machine inference with the
 * same authority as a colleague's ruling — the column would otherwise read as if the team had
 * already triaged 23,000 claims.
 *
 * The hue is kept in both forms so the state stays readable at a glance; only the fill changes.
 * Colour is never the sole carrier: the `title` says which kind it is in words.
 */
export function WorkChip({ status, derived = false }: { status: ArWorkStatus | string; derived?: boolean }) {
  const meta = WORK_STATUS_META.find((m) => m.value === status);
  const t = TONE[meta?.tone ?? 'neutral'] ?? TONE.neutral!;
  const label = meta?.label ?? status;
  return (
    <span
      className={`inline-flex items-center rounded-md px-2 py-0.5 text-xs ${derived ? 'font-medium' : 'font-semibold'}`}
      style={derived
        ? { color: t.fg, backgroundColor: 'transparent', boxShadow: `inset 0 0 0 1px ${t.fg}66` }
        : { color: t.fg, backgroundColor: t.bg }}
      title={derived ? `${label} — from CMD's data; nobody has triaged this claim yet` : `${label} — set by a person`}
    >
      {label}
    </span>
  );
}

/** Top denial codes as mono pills — `CO 197`, `PI 45` — with the summed amount on hover. */
export function DenialPills({ items, max = 2 }: { items: ArDenialSummaryItem[]; max?: number }) {
  if (!items || items.length === 0) return <span className="text-xs text-ink400">—</span>;
  const shown = items.slice(0, max);
  const rest = items.length - shown.length;
  return (
    <span className="inline-flex flex-wrap items-center gap-1">
      {shown.map((d) => (
        <span key={`${d.g ?? ''}-${d.c}`} className="ths-num inline-flex items-center rounded border border-line bg-ground px-1.5 py-0.5 text-xs font-medium text-ink900" title={`${d.g ?? ''} ${d.c} · ${money(d.amt)} across ${d.n} line${d.n === 1 ? '' : 's'}`}>
          {d.g ? <span className="mr-1 text-ink400">{d.g}</span> : null}
          {d.c}
        </span>
      ))}
      {rest > 0 ? <span className="text-xs text-ink400">+{rest}</span> : null}
    </span>
  );
}

/** The masked patient cell: a fixed mask (never a partial name) plus the opaque CMD id. */
export function PatientMask({ revealed, cmdPatientId }: { revealed: { name: string; member: string | null } | null; cmdPatientId: string }) {
  return (
    <span className="flex flex-col leading-tight">
      <span className={revealed ? 'font-medium text-ink900' : 'tracking-widest text-ink400'}>{revealed ? revealed.name : '••••••'}</span>
      <span className="ths-num text-xs text-ink400">{revealed?.member ? revealed.member : `#${cmdPatientId}`}</span>
    </span>
  );
}

/** 835 CLP02 claim-status code → wording. */
export function clp02Label(code: string | null | undefined): string | null {
  switch ((code ?? '').trim()) {
    case '1': return 'Processed as primary';
    case '2': return 'Processed as secondary';
    case '3': return 'Processed as tertiary';
    case '4': return 'Denied';
    case '19': return 'Processed as primary, forwarded';
    case '20': return 'Processed as secondary, forwarded';
    case '21': return 'Processed as tertiary, forwarded';
    case '22': return 'Reversal of prior payment';
    case '23': return 'Not our claim, forwarded';
    case '25': return 'Predetermination pricing only';
    default: return null;
  }
}
