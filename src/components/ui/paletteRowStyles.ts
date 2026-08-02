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
  // The outline is the rail's own colour at /40 — one anchor drawn twice, not
  // two signals. It shares that /40 with the palette input's focus border
  // (`AppPaletteDialog`), so both land on the same rendered green and the
  // surface reads as one treatment rather than two strengths; change them
  // together. /25 was tried and sat inside the noise of the neutral border it
  // replaced. Every theme's accent drives it, so the outline and the rail can
  // never disagree about what colour "selected" is.
  "aria-selected:bg-overlay-raised aria-selected:border-daintree-accent/40 aria-selected:text-daintree-text",
  // The rail is always laid out and only its opacity changes. Toggling
  // `content` instead gave the pseudo-element nothing to transition from.
  "before:absolute before:top-2 before:bottom-2 before:left-0 before:w-[2px] before:rounded-r",
  "before:bg-daintree-accent before:opacity-0 before:transition-opacity before:content-['']",
  "aria-selected:before:opacity-100"
);

/**
 * The label that names a band of rows ("Pinned", "Scratch", "Recent").
 *
 * Same drift as the row treatment: most palettes drew it as a 10px tracked
 * uppercase whisper, while the dock launcher used 11px sentence case — so the
 * same structural element read as two different things depending on which
 * palette you opened. Padding stays out of it where a palette's list inset
 * differs; the type treatment is what has to match.
 */
export const PALETTE_SECTION_LABEL_CLASS =
  "text-[10px] font-medium tracking-wider uppercase text-daintree-text/40 select-none";
