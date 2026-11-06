import { cn } from "@/lib/utils";
import { HighlightedText } from "./HighlightedText";

type Ranges = readonly (readonly [number, number])[] | undefined;

/** How far from the end the kept tail may start, and its length when no separator falls in that span. */
const TAIL_SPAN = 20;
const TAIL_FALLBACK = 12;

/**
 * Where the kept tail starts: at the first separator inside the final stretch
 * of the string, so the tail reads as whole words
 * (`…-layout-flushes-miss`, `…/feature-auth-token-retry`), or a fixed number
 * of characters when there is none. Never on whitespace, because an accessible
 * name trims the space at a span boundary and runs two words together.
 */
export function tailStart(text: string): number {
  if (text.length <= TAIL_SPAN + 4) return 0;
  const from = text.length - TAIL_SPAN;
  for (let i = from; i < text.length - 4; i++) {
    if ("/-_.".includes(text[i]!)) return i;
  }
  let split = text.length - TAIL_FALLBACK;
  while (split < text.length - 1 && /\s/.test(text[split - 1]! + text[split]!)) split++;
  return split;
}

/** Match ranges on a whole string, moved onto its `[start, end)` slice. */
export function sliceRanges(
  ranges: Ranges,
  start: number,
  end: number
): [number, number][] | undefined {
  if (!ranges) return undefined;
  const out: [number, number][] = [];
  for (const [s, e] of ranges) {
    if (e < start || s >= end) continue;
    out.push([Math.max(s, start) - start, Math.min(e, end - 1) - start]);
  }
  return out.length > 0 ? out : undefined;
}

/**
 * Text that clips in the middle instead of at the end, so the part that tells
 * near-identical names apart survives. Branches and worktree folders share long
 * prefixes (`feature/auth-token-refresh`, `-retry`, `-refresh-v2`) and differ
 * at the end, which is exactly what an end ellipsis threw away. The same shape
 * as `HostNameText`: a head that truncates and a tail that never shrinks, laid
 * out by flex rather than measured, so it renders contiguously when it fits.
 */
export function TailKeepingText({
  text,
  indices,
  className,
}: {
  text: string;
  /** Match ranges on the whole text, split across the two halves. */
  indices?: Ranges;
  className?: string;
}) {
  const split = tailStart(text);
  if (split === 0) {
    return (
      <span className={cn("min-w-0 truncate", className)}>
        <HighlightedText text={text} indices={indices} />
      </span>
    );
  }
  return (
    <span className={cn("flex min-w-0", className)}>
      <span className="min-w-[4ch] truncate whitespace-pre">
        <HighlightedText text={text.slice(0, split)} indices={sliceRanges(indices, 0, split)} />
      </span>
      <span className="shrink-0 whitespace-pre">
        <HighlightedText
          text={text.slice(split)}
          indices={sliceRanges(indices, split, text.length)}
        />
      </span>
    </span>
  );
}
