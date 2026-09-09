/** Row flags → pills. Labels say what the signal IS, not what it implies (pct_zero_paid is not a denial rate). */
import type { CodePerfFlag } from '@/lib/code-performance/contract';

export const FLAG_META: Record<CodePerfFlag, { label: string; tone: 'warn' | 'danger' | 'muted'; title: string }> = {
  no_procedure_code: { label: 'no procedure code', tone: 'muted', title: 'CMD reported no HCPCS/CPT on these charge lines (literal em dash).' },
  no_revenue_code: { label: 'no revenue code', tone: 'muted', title: 'CMD reported no revenue code on these charge lines.' },
  not_clinical: { label: 'not clinical', tone: 'muted', title: 'Interest posting in the procedure slot — exclude from clinical yield reads.' },
  allowed_unreliable: { label: 'allowed unreliable', tone: 'warn', title: 'Fewer than 60% of charges have a reliable allowed amount; the allowed rate describes a minority.' },
  immature_window: { label: 'immature', tone: 'warn', title: 'Fewer than 60% of charges are 45+ days old; yield reads low for mechanical reasons.' },
  dormant: { label: 'dormant', tone: 'muted', title: 'No charge on this pairing for 90+ days.' },
  paid_over_allowed: { label: 'paid > allowed', tone: 'danger', title: 'Insurance paid more than the reliable allowed — overpayment / clawback exposure.' },
  high_zero_paid: { label: 'high zero-pay', tone: 'warn', title: '20%+ of charges have no insurance payment. A signal, not a denial rate.' },
  wide_facility_spread: { label: 'wide facility spread', tone: 'warn', title: 'Allowed rate differs by 25+ points across facilities with 30+ charges.' },
};

const TONE: Record<'warn' | 'danger' | 'muted', string> = {
  warn: 'bg-status-warn/10 text-status-warn',
  danger: 'bg-status-danger/10 text-status-danger',
  muted: 'bg-teal50 text-ink600',
};

export function FlagPills({ flags }: { flags: CodePerfFlag[] }) {
  if (flags.length === 0) return <span className="text-xs text-ink400">—</span>;
  return (
    <div className="flex max-w-[16rem] flex-wrap gap-1">
      {flags.map((f) => (
        <span key={f} className={`rounded-full px-1.5 py-0.5 text-xs font-semibold ${TONE[FLAG_META[f].tone]}`} title={FLAG_META[f].title}>
          {FLAG_META[f].label}
        </span>
      ))}
    </div>
  );
}
