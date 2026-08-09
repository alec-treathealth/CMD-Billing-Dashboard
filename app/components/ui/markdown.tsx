/**
 * MARKDOWN → REACT, for streamed model answers. Small, total, and safe by construction.
 *
 * WHY IT EXISTS (Alec, 2026-08-09: "Make sure all AI responses are rendering in HTML markdown and
 * NOT showing **asterisks** or ## hashtags as it is right now"). Every AI surface in this app rendered
 * the model's text into `whitespace-pre-wrap`, so the markdown the prompts explicitly ASK for
 * ("Output EXACTLY these three markdown sections", "2-4 short bullets") arrived on screen as literal
 * `**` and `##`. The section splitter (`parseAiSections`) eats the three top-level `##` headers, which
 * hid the problem for the headers and for nothing else: every bullet, every bolded payer name, and
 * every `###` the model chose to add rendered raw.
 *
 * ⚠ NO RAW-HTML SINK, EVER — this component builds React ELEMENTS from a token scan and never hands
 * a string to React's raw-HTML escape hatch. Model output is untrusted text: it is assembled from
 * data we chose, but the model is not a template we control, and a prompt-injected string reaching an
 * HTML sink on a PHI-adjacent surface is not a risk worth a shortcut. There is no HTML parse step
 * here at all, so raw HTML in the source renders as visible text — the correct and boring outcome.
 *
 * SUPPORTED SUBSET — deliberately what the prompts ask for and nothing else:
 *   blocks   `#`..`######` headings · `-`/`*`/`+` bullets · `1.`/`1)` ordered items · paragraphs
 *   inline   `**bold**` · `__bold__` · `*em*` · `_em_` · `` `code` ``
 * Anything else falls through as text. Unclosed markers — the NORMAL state mid-stream, when only
 * `**Aet` has arrived — also fall through as text and resolve themselves on the next token, which is
 * why every inline rule demands its CLOSING delimiter instead of treating an opener as state.
 */
import type { ReactNode } from 'react';

/** `**b**` / `__b__` / `*i*` / `_i_` / `` `c` `` — longest openers first so `**` never matches as `*`.
 *  Each alternative demands its closing delimiter on the same line (see the mid-stream note above). */
const INLINE = /(`[^`\n]+`)|(\*\*[^\n]+?\*\*)|(__[^\n]+?__)|(\*[^*\n]+?\*)|(_[^_\n]+?_)/g;

/** Inline spans within one line of text. Pure; returns plain strings when nothing matches. */
export function inlineMarkdown(text: string, keyPrefix = 'i'): ReactNode[] {
  const out: ReactNode[] = [];
  let last = 0;
  let n = 0;
  for (const m of text.matchAll(INLINE)) {
    const raw = m[0];
    const at = m.index;
    if (at > last) out.push(text.slice(last, at));
    const key = `${keyPrefix}-${n++}`;
    if (raw.startsWith('`')) {
      out.push(
        <code key={key} className="rounded bg-surface px-1 py-0.5 font-mono text-[0.92em]">
          {raw.slice(1, -1)}
        </code>,
      );
    } else if (raw.startsWith('**') || raw.startsWith('__')) {
      // Nested emphasis inside strong is real markdown and costs one recursive call.
      out.push(
        <strong key={key} className="font-semibold">
          {inlineMarkdown(raw.slice(2, -2), key)}
        </strong>,
      );
    } else {
      out.push(<em key={key}>{raw.slice(1, -1)}</em>);
    }
    last = at + raw.length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

type Block =
  | { kind: 'heading'; level: number; text: string }
  | { kind: 'list'; ordered: boolean; items: string[] }
  | { kind: 'para'; text: string };

const HEADING = /^\s{0,3}(#{1,6})\s+(.*)$/;
const BULLET = /^\s*[-*+]\s+(.*)$/;
const ORDERED = /^\s*\d{1,3}[.)]\s+(.*)$/;

/**
 * Line-oriented block scan. Paragraph lines JOIN with a space (markdown's own rule) rather than
 * preserving the model's wrap column — the previous `whitespace-pre-wrap` rendering inherited
 * whatever line length the model happened to emit, which read as deliberate line breaks and was not.
 * A blank line ends a block.
 */
export function markdownBlocks(text: string): Block[] {
  const blocks: Block[] = [];
  let para: string[] = [];
  const flushPara = () => {
    if (para.length > 0) {
      blocks.push({ kind: 'para', text: para.join(' ') });
      para = [];
    }
  };
  for (const line of text.split('\n')) {
    if (line.trim() === '') {
      flushPara();
      continue;
    }
    const h = line.match(HEADING);
    if (h) {
      flushPara();
      blocks.push({ kind: 'heading', level: h[1]!.length, text: h[2]!.trim() });
      continue;
    }
    const b = line.match(BULLET);
    const o = b ? null : line.match(ORDERED);
    if (b || o) {
      flushPara();
      const item = (b ? b[1]! : o![1]!).trim();
      const ordered = o !== null;
      const tail = blocks[blocks.length - 1];
      // Only extend the previous list when it is the SAME kind — a bulleted block immediately
      // followed by a numbered one is two lists, not one with a confused marker.
      if (tail && tail.kind === 'list' && tail.ordered === ordered) tail.items.push(item);
      else blocks.push({ kind: 'list', ordered, items: [item] });
      continue;
    }
    para.push(line.trim());
  }
  flushPara();
  return blocks;
}

const HEADING_CLASS: Record<number, string> = {
  1: 'text-[15px] font-semibold',
  2: 'text-[14px] font-semibold',
  3: 'text-[13.5px] font-semibold',
  4: 'text-[13px] font-semibold',
  5: 'text-[13px] font-semibold',
  6: 'text-[13px] font-semibold',
};

/**
 * Render a model answer (or one parsed section of one) as real markup.
 *
 * `className` styles the WRAPPER, not the blocks — size and colour stay with the caller, so this
 * drops into an existing panel without changing how that panel's prose reads. Renders nothing at all
 * for empty/whitespace text, so a caller can mount it unconditionally while a section is still empty
 * mid-stream.
 */
export function Markdown({ text, className = '' }: { text: string; className?: string }) {
  const blocks = markdownBlocks(text);
  if (blocks.length === 0) return null;
  return (
    <div className={className}>
      {blocks.map((b, i) => {
        if (b.kind === 'heading') {
          // A model-chosen sub-heading inside a section body. Rendered as a styled div rather than a
          // real <h*>: these sit INSIDE the panel's own heading hierarchy, and injecting an <h3> the
          // panel never planned for reorders the document outline a screen-reader user navigates by.
          return (
            <div key={i} className={`${i > 0 ? 'mt-2.5 ' : ''}${HEADING_CLASS[b.level] ?? HEADING_CLASS[6]}`}>
              {inlineMarkdown(b.text, `h${i}`)}
            </div>
          );
        }
        if (b.kind === 'list') {
          const cls = `${i > 0 ? 'mt-1.5 ' : ''}space-y-1 pl-4 ${b.ordered ? 'list-decimal' : 'list-disc'}`;
          return b.ordered ? (
            <ol key={i} className={cls}>
              {b.items.map((it, j) => (
                <li key={j}>{inlineMarkdown(it, `l${i}-${j}`)}</li>
              ))}
            </ol>
          ) : (
            <ul key={i} className={cls}>
              {b.items.map((it, j) => (
                <li key={j}>{inlineMarkdown(it, `l${i}-${j}`)}</li>
              ))}
            </ul>
          );
        }
        return (
          <p key={i} className={i > 0 ? 'mt-2' : ''}>
            {inlineMarkdown(b.text, `p${i}`)}
          </p>
        );
      })}
    </div>
  );
}
