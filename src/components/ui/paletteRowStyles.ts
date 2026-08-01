import { cn } from "@/lib/utils";

/**
 * The one definition of "this is the row Enter will act on".
 *
 * Five palettes had grown five spellings of the same visual: two drove it from
 * a JS `isSelected` ternary and three from the `aria-selected` attribute, two
 * rounded the rail's trailing edge and three did not, and two cross-faded the
 * rail while three popped it into existence with nothing to transition — which
 * left the rail arriving on the new row while the surface behind it was still
 * fading in.
 *
 * Authority is the rendered `aria-selected` attribute, not a prop. One source
 * of truth means the announcement and the highlight cannot disagree, and a row's
 * children can key off `group-aria-selected:` without a second boolean being
 * threaded down to them.
 *
 * Layout is deliberately NOT here. These rows are different shapes — some align
 * to the first line, some centre, and their padding and gaps differ — so each
 * site keeps its own box and its own resting tone, and takes only the selected
 * treatment from this.
 */
export const PALETTE_ROW_CLASS = cn(
  // `relative` is the rail's containing block; the transparent border reserves
  // the selected border's width so the row cannot shift when it arrives.
  "relative border border-transparent transition-colors",
  "aria-selected:bg-overlay-raised aria-selected:border-overlay aria-selected:text-daintree-text",
  // The rail is always laid out and only its opacity changes. Toggling
  // `content` instead gave the pseudo-element nothing to transition from.
  "before:absolute before:top-2 before:bottom-2 before:left-0 before:w-[2px] before:rounded-r",
  "before:bg-daintree-accent before:opacity-0 before:transition-opacity before:content-['']",
  "aria-selected:before:opacity-100"
);
