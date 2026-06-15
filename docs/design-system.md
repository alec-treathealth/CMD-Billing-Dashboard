# Design System — CMD Billing Dashboard

TreatHealthOS visual system applied to an internal PHI-aware billing dashboard.

---

## Palette

| Token | Hex | Use |
|---|---|---|
| `teal900` | `#0E3A3A` | Header background |
| `teal700` | `#135E5A` | Primary buttons, action links, active nav text |
| `teal500` | `#1C8B82` | KPI tile top border, active tab underline |
| `teal200` | `#B7DAD5` | Field-picker border |
| `teal50` | `#EAF4F2` | Field-picker background, muted notice background |
| `coral600` | `#E2674F` | Logo facet (decorative only) |
| `ground` | `#FBF8F4` | Page background |
| `surface` | `#FFF` | Card background |
| `ink900` | `#1B2B2A` | Body text |
| `ink600` | `#4A5C5A` | Secondary text, notice text |
| `ink400` | `#859794` | Muted / placeholder |
| `line` | `#E4E9E6` | Borders |
| `status-danger` | `#C0453B` | Error states |
| `status-ok` | `#2E8B6F` | Success |
| `status-warn` | `#C9881E` | Warning |

---

## Typography

| Role | Font | Weight | Notes |
|---|---|---|---|
| Headings (`ths-h`) | Space Grotesk | 500–700 | `tracking-tight` (`-0.02em`) |
| Body | Inter | 400–600 | `tracking-[-0.006em]` |
| Numeric / tabular (`ths-num`) | IBM Plex Mono | 400–500 | `tabular-nums` |

Page `<h1>` always uses `text-2xl font-semibold tracking-tight`.
Card titles use `text-base font-semibold` (via `CardTitle`).

---

## Layout

Every page shell:
```tsx
<main className="mx-auto max-w-5xl space-y-6 p-6 sm:p-10">
  <header>
    <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
    <p className="mt-1 text-sm text-muted-foreground">{description}</p>
  </header>
  {/* content */}
  <footer className="mt-10 border-t pt-4 text-xs text-muted-foreground">
    Internal tool — handles PHI…
  </footer>
</main>
```

Claims Explorer uses `max-w-6xl`; claim detail uses `max-w-3xl`.

---

## Components

### KPI tile
```tsx
<Card className="border-t-2 border-t-teal500">
  <CardContent className="pt-6">
    <div className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{label}</div>
    <div className="ths-num mt-1 text-2xl font-semibold tabular-nums text-teal700">{value}</div>
  </CardContent>
</Card>
```

### Widget card (dashboard)
Uses `WidgetCard` in `dashboard.tsx`. Renders:
- **Loading:** 3-line skeleton pulse (`Skeleton` from `ui/skeleton`)
- **Error:** red-bordered notice — `border-destructive/40 bg-destructive/10 text-destructive`
- **Ready:** widget-specific content

### Skeleton
```tsx
import { Skeleton } from '@/components/ui/skeleton';
<Skeleton className="h-4 w-3/4" />
```
`animate-pulse rounded-md bg-muted` — use for any data-pending placeholder.

### Notice banner
```tsx
// In search-console.tsx — tone: 'muted' | 'error'
<Notice tone="muted">…</Notice>  // teal50 bg, teal200 border, ink600 text
<Notice tone="error">…</Notice>  // status-danger/10 bg, /30 border
```

### MiniBar (proportional)
```tsx
<MiniBar pct={42} />  // decorative 0–100 bar; values always shown as text too
```
`h-1.5 rounded bg-muted` track, `bg-primary/60` fill.

### User message bubble (chat)
```tsx
<div className="flex justify-end">
  <div className="max-w-[85%] rounded-lg rounded-br-sm bg-teal700 px-3 py-2 text-sm text-white">
    {text}
  </div>
</div>
```

### Field picker
Teal-bordered card (`border-teal200 bg-teal50/40`) that collects only non-PHI `ClaimFilter` fields. Shown when the agent decides a query is too broad. Never requests patient identifiers.

---

## Navigation

### Top nav (`NavLinks`)
Client component — reads `usePathname()` to highlight the active section.
- Active: `bg-white/15 font-semibold text-white`
- Inactive: `text-white/75 hover:bg-white/10 hover:text-white`

### Dashboard sub-nav (`DashboardNav`)
Client component — same `usePathname()` pattern for the three tabs (Overview / Payers / Collections).
- Active: `border-teal500 text-teal700`
- Inactive: `border-transparent text-muted-foreground`

---

## PHI rules (enforced in code, not just policy)

- PHI columns listed in `lib/phi.ts` (`PHI_BASE_COLUMNS`).
- `isPhiColumn()` + `displayCell()` apply masking; bypass only on explicit per-row reveal.
- `ResultsTable` renders `••••••` by default for PHI columns.
- `IdentityForm` holds patient inputs in **local component state only** — never lifted or persisted.
- Nothing in the transcript (questions, summaries, rows) is written to `localStorage` / cookies.
- `/claims` list and `/claims/[id]` detail project **non-PHI columns only** — no masking needed, but `displayCell` is still applied as defense-in-depth.
