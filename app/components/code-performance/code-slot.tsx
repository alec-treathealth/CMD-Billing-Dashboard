/**
 * One code cell — procedure or revenue — rendered through the ONE helper both no-code shapes share
 * (038 D): the em dash and a NULL both read "No … code reported", same style, same flag. The
 * description comes from ref.code_description (precedence already resolved server-side) and carries
 * its review markers: every seeded row is unreviewed; S9475 is the one flagged conflict.
 */
import { describeCodeSlot } from '../../../src/collections/codePerformanceQuery.js';
import { descriptionKey, type CodeDescription, type CodeDescriptionMap, type CodeSlotKind } from '@/lib/code-performance/contract';

export function lookupDescription(
  kind: CodeSlotKind,
  code: string | null,
  descriptions: CodeDescriptionMap,
): CodeDescription | undefined {
  const slot = describeCodeSlot(kind, code);
  return slot.lookupCode ? descriptions[descriptionKey(kind, slot.lookupCode)] : undefined;
}

export function ReviewMarkers({ desc }: { desc: CodeDescription | undefined }) {
  if (!desc) return null;
  return (
    <>
      {desc.needsReview && (
        <span
          className="rounded-full bg-status-warn/10 px-1.5 py-0.5 text-xs font-semibold text-status-warn"
          title="Description not yet validated against an authoritative source (needs_review = true)"
        >
          unreviewed
        </span>
      )}
      {desc.descriptionConflict && (
        <span
          className="rounded-full bg-status-danger/10 px-1.5 py-0.5 text-xs font-semibold text-status-danger"
          title={`Two sources disagree in substance. Other reading: ${desc.priorDescription ?? ''}`}
        >
          conflict
        </span>
      )}
    </>
  );
}

export function CodeSlot({
  kind,
  code,
  suffix,
  descriptions,
}: {
  kind: CodeSlotKind;
  code: string | null;
  /** Level-of-care suffix CMD welded onto the CPT (Indigo); kept as its own dimension, shown as a pill. */
  suffix?: string | null;
  descriptions: CodeDescriptionMap;
}) {
  const slot = describeCodeSlot(kind, code);
  const desc = lookupDescription(kind, code, descriptions);
  return (
    <div className="min-w-0">
      <div className="flex flex-wrap items-center gap-1.5">
        <span className={slot.noCode ? 'ths-num italic text-ink600' : 'ths-num font-semibold text-ink900'}>
          {slot.label}
        </span>
        {suffix && (
          <span
            className="rounded-full bg-teal50 px-1.5 py-0.5 text-xs font-semibold text-teal700"
            title="Level-of-care suffix CMD welded onto the code; stripped for the pairing key and kept as its own dimension"
          >
            {suffix}
          </span>
        )}
        <ReviewMarkers desc={desc} />
      </div>
      {!slot.noCode && (
        <div className="max-w-[26rem] text-xs text-ink600">{desc?.shortLabel ?? 'No description on file'}</div>
      )}
    </div>
  );
}
