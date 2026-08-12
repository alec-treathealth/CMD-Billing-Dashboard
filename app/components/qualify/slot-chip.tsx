'use client';

/**
 * ONE SLOT-CHIP — a sentence template with enum dropdowns in it (Smoke Phase 2, 2026-08-10).
 *
 * IN ITS OWN MODULE ON PURPOSE, for the reason aiPayload.ts records at length: qualify-ai-panel.tsx
 * is a `'use client'` module that imports the `ai-actions` server chain, so anything defined inside
 * it cannot be imported by a hermetic render test. The last thing that lived there and shouldn't
 * have was the AI payload mapping, and deleting a field from it left every suite and both
 * typechecks green. A chip whose entire purpose is to constrain what reaches a model is not a thing
 * to leave untestable — so it lives here and the panel imports it.
 *
 * NOT A <button>, and that is a constraint rather than a preference: a <select> inside a <button> is
 * invalid HTML, and in practice the button swallows the click so the dropdown never opens. The chip
 * is therefore a group with its own trailing Ask control. Chips WITHOUT slots keep the original
 * <button> in the panel untouched — the pre-Phase-2 path stays byte-identical rather than being
 * ported onto this shape and revalidated.
 *
 * The control emits template id + slot values and nothing else. There is no text input here and
 * none may be added; see the `slots` field on QualifyAiInputSchema for why that is structural.
 */
import {
  slotChoices,
  templateSentence,
  SLOT_LABELS,
  type QualifyChipSlots,
  type QualifyChipTemplate,
  type QualifySlotKey,
} from '../../lib/qualify/chipTemplates';
import type { QualifySnapshot } from '../../lib/qualify/contract';

export function SlotChip({
  template,
  snapshot,
  slots,
  active,
  suggested,
  onChange,
  onAsk,
}: {
  template: QualifyChipTemplate;
  snapshot: QualifySnapshot;
  slots: QualifyChipSlots;
  active: boolean;
  suggested: boolean;
  onChange: (next: QualifyChipSlots) => void;
  onAsk: () => void;
}) {
  const set = (key: QualifySlotKey, raw: string) => {
    // The <option value> round-trips through a string; facility slots are numeric indices and the
    // horizon is a number, so both are parsed back rather than stored as text. A NaN would reach the
    // schema as an invalid type and fail the whole request, so it degrades to null instead.
    const numeric = key === 'facility' || key === 'comparator' || key === 'horizonDays';
    const parsed = numeric ? Number.parseInt(raw, 10) : raw;
    const value = numeric && Number.isNaN(parsed as number) ? null : parsed;
    onChange({ ...slots, [key]: value } as QualifyChipSlots);
  };

  // The sentence THIS chip currently reads as, given the picked slot values — the group's
  // accessible name and the seed for the Ask button's, so AT announces the question rather than
  // "group" followed by a run of unlabelled controls (the confirmed review finding).
  const sentence = templateSentence(template, snapshot, slots);

  return (
    <div
      role="group"
      aria-label={sentence}
      data-testid="qualify-slot-chip"
      className={[
        'flex flex-wrap items-center gap-x-1 gap-y-1.5 rounded-xl border px-3 py-2 text-left text-[12.5px] font-semibold leading-snug transition-colors',
        active
          ? 'border-teal500 bg-teal50 text-teal700'
          : suggested
            ? 'border-teal200 bg-teal50 text-ink600'
            : 'border-line bg-surface text-ink600',
      ].join(' ')}
    >
      {suggested ? (
        <span aria-hidden className="text-teal500">
          ✦
        </span>
      ) : null}
      {template.segments.map((segment, i) => {
        if (segment.kind === 'text') return <span key={i}>{segment.text}</span>;
        const choices = slotChoices(snapshot, segment.slot);
        const value = slots[segment.slot];
        if (segment.locked) {
          // The mock's `.slot--locked`: shown, never editable. The guardrail made visible — the
          // lane's subject is not changeable from inside the lane.
          const label = choices.find((c) => String(c.value) === String(value))?.label ?? '—';
          return (
            <span key={i} className="rounded bg-teal50 px-1.5 py-0.5 text-teal700">
              {label}
            </span>
          );
        }
        return (
          <select
            key={i}
            aria-label={SLOT_LABELS[segment.slot]}
            value={value === null ? '' : String(value)}
            onChange={(e) => set(segment.slot, e.target.value)}
            /* ⚠ THE 13rem PIN STAYS — an edit here was proposed on 2026-08-12 and WITHDRAWN in
               review, recorded so nobody re-proposes it. The reasoning was "a 208px cap cannot fit
               the 416px lane rail". That is backwards twice over: a `max-width` can only make a box
               NARROWER, so the cap was never what stopped the control fitting anywhere — it is the
               only thing keeping this `<select>` from growing to its widest `<option>` — and 208px
               fits a 416px rail with room to spare. Relaxing it to `max-w-full` would have widened
               the control ~2.4x on the FULL-WIDTH v2 tab, a surface that brief never touched, and
               `truncate` means the difference is a visible ellipsis rather than a theoretical one. */
            className="max-w-[13rem] cursor-pointer truncate rounded border border-teal200 bg-surface px-1 py-0.5 font-semibold text-teal700 underline decoration-dotted underline-offset-2"
          >
            {choices.map((choice) => (
              <option key={String(choice.value)} value={String(choice.value)}>
                {choice.label}
              </option>
            ))}
          </select>
        );
      })}
      <button
        type="button"
        onClick={onAsk}
        aria-pressed={active}
        aria-label={`Ask: ${sentence}`}
        className="ml-auto rounded-lg border border-teal200 px-2 py-1 text-[11.5px] font-semibold text-teal700 transition-colors hover:bg-teal50"
      >
        Ask
      </button>
    </div>
  );
}
