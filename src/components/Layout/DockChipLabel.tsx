import type { ComponentPropsWithRef } from "react";
import { cn } from "@/lib/utils";

/** Titles at or under this many characters never need their end kept. */
const SPLIT_MIN_LENGTH = 18;
/** A tail longer than this is no longer "the end", it is half the title. */
const TAIL_MAX_LENGTH = 14;

/**
 * Splits a title into a head that may truncate and a tail that never does: the
 * last word, or the last two when the last is a short token ("4", "2)").
 *
 * Two sessions doing related work share a prefix far more often than an end —
 * "Fix the flaky shutdown suite" and "Fix the flaky shutdown suite on Windows" —
 * and an end-truncated chip renders both as "Fix the flaky shutdo…". Keeping
 * the end on screen is what tells them apart.
 */
export function splitDockChipLabel(title: string): [head: string, tail: string] {
  if (title.length <= SPLIT_MIN_LENGTH) return [title, ""];
  let cut = title.lastIndexOf(" ");
  if (cut <= 0) return [title, ""];
  if (title.length - cut - 1 <= 3) {
    const previous = title.lastIndexOf(" ", cut - 1);
    if (previous > 0) cut = previous;
  }
  // The space stays on the head, so a truncated head's ellipsis meets the tail
  // the way a Finder name does ("Fix the flaky shutdo…suite") rather than
  // leaving a gap that reads as a second field.
  const tail = title.slice(cut + 1);
  if (tail.trim().length === 0 || tail.length > TAIL_MAX_LENGTH) return [title, ""];
  return [title.slice(0, cut + 1), tail];
}

/**
 * A chip's visible title, truncated in the middle. Purely visual: every chip
 * states its full name in its own `aria-label`, which split text alone would
 * collapse ("Session" + " 1" computes as "Session1").
 */
export function DockChipLabel({
  title,
  className,
  ...rest
}: { title: string } & Omit<ComponentPropsWithRef<"span">, "title" | "children">) {
  const [head, tail] = splitDockChipLabel(title);
  // Spreads the rest so a TooltipTrigger (asChild) can attach its ref and
  // pointer handlers to the label.
  return (
    <span
      {...rest}
      className={cn("flex min-w-[48px] max-w-[160px] font-sans font-medium", className)}
    >
      <span className="min-w-0 truncate whitespace-pre">{head}</span>
      {tail && <span className="shrink-0 whitespace-pre">{tail}</span>}
    </span>
  );
}
