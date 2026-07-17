'use client';

/**
 * Qualify — no-data VOB modal. Opens when a real search resolved to nothing (snapshot.resolved ===
 * null after a >= 3-char query). Echoes the searched identifier (non-PHI: the user's own input) and
 * offers to start a verification of benefits.
 *
 * "Start VOB" ships INERT with a marked TODO seam — no endpoint is wired yet (Alec confirmed:
 * inert-with-seam). Do not silently point it anywhere.
 */
import { AlertTriangle } from 'lucide-react';

export function VobModal({
  open,
  query,
  onClose,
}: {
  open: boolean;
  query: string;
  onClose: () => void;
}) {
  if (!open) return null;
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-[rgba(14,44,44,0.42)] p-5"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="qualify-vob-title"
        className="w-full max-w-md overflow-hidden rounded-2xl bg-card shadow-ths-lg"
      >
        <div className="flex items-start gap-3.5 px-6 pb-1.5 pt-5">
          <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-[10px] bg-coral50 text-coral600">
            <AlertTriangle aria-hidden className="h-5 w-5" />
          </div>
          <div>
            <h3 id="qualify-vob-title" className="font-head text-lg font-semibold">
              No matching cases
            </h3>
            <p className="text-xs text-muted-foreground">
              Nothing resolved for this identifier in the selected window.
            </p>
          </div>
        </div>

        <div className="px-6 pb-1 pl-[78px] text-[13.5px] text-muted-foreground">
          <div className="my-2.5 rounded-lg border bg-background px-3 py-2.5 font-mono text-[13px] text-ink900">
            <span className="mb-0.5 block font-sans text-[10px] font-semibold uppercase tracking-wider text-ink400">
              Searched
            </span>
            {query}
          </div>
          Start a verification of benefits to open this lead.
        </div>

        <div className="flex items-center gap-2.5 px-6 pb-5 pl-[78px] pt-4">
          {/* TODO(qualify-vob): wire to <target> once Alec confirms the endpoint (Monday VOB board /
              n8n webhook). Inert today by design — the button intentionally has no handler. */}
          <button type="button" className="rounded-lg bg-coral600 px-4 py-2 text-[13px] font-semibold text-white shadow-sm">
            Start VOB
          </button>
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg border border-teal200 bg-teal50 px-4 py-2 text-[13px] font-semibold text-teal700"
          >
            Close
          </button>
          <span className="ml-auto text-[11px] font-semibold text-status-warn">CTA inert · TODO</span>
        </div>
      </div>
    </div>
  );
}
