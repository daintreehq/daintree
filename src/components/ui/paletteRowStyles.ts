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
  // `palette-row` is not styling — it is the handle the `forced-colors: active`
  // block in `index.css` needs. There the raised fill is discarded and the row
  // has to redraw itself from system keywords, and `[role="option"]` is far too
  // broad a hook: the file pane, the settings selectors and the agent/forge
  // dropdowns all use it too. The transparent resting border reserves the
  // selected border's width so the row cannot shift when it arrives.
  "palette-row border border-transparent transition-colors",
  // Neutral, not accent (#11686). The fill alone can't be the indicator — it
  // clears about 1.1-1.2:1 against the palette surface — so `selection-outline`
  // carries WCAG 1.4.11 at 3:1 for the pair. It is the same token the palette
  // input's focus border uses (`AppPaletteDialog`), so the focused field and the
  // selected row are one treatment at two strengths rather than two colours;
  // change them together. Earlier attempts at a neutral outline failed because
  // they reused the resting border ladder, which is tuned for separation and
  // sits inside its own noise when asked to be the only signal.
  "aria-selected:bg-overlay-raised aria-selected:border-selection-outline aria-selected:text-daintree-text"
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
