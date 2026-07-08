/**
 * TreatHealthOS wordmark, product line underneath — mirrors the Continuity app's Logo.
 * Server-safe (no client hooks); used by the full-page auth screens (/login,
 * /forgot-password) that render their own chrome in place of the global header.
 */
export function Wordmark({ dark = false }: { dark?: boolean }) {
  return (
    <span className="relative inline-flex select-none flex-col">
      <span className="inline-flex items-baseline gap-1.5">
        <span
          aria-hidden
          className={`inline-block h-2.5 w-2.5 translate-y-[-1px] rounded-[3px] ${dark ? 'bg-[#5FBFA8]' : 'bg-[#0D5C4D]'}`}
        />
        <span
          className={`font-display text-lg font-semibold tracking-tight ${dark ? 'text-white' : 'text-[#16211C]'}`}
        >
          TreatHealth<span className={dark ? 'text-[#5FBFA8]' : 'text-[#0D5C4D]'}>OS</span>
        </span>
      </span>
      <span
        className={`mt-0.5 pl-4 text-[10px] font-semibold uppercase tracking-[0.22em] ${dark ? 'text-white/50' : 'text-[#75847D]'}`}
      >
        Billing · RCM
      </span>
    </span>
  );
}
