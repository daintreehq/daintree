import { cn } from "@/lib/utils";

/**
 * The one definition of "this is the row Enter will act on".
 *
 * Five palettes had grown five spellings of the same visual: two drove it from
 * a JS `isSelected` ternary and three from the `aria-selected` attribute, and
 * their marks drifted apart from there.
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
  // `palette-row` is not styling — it is the handle the increased-contrast and
  // `forced-colors: active` blocks in `index.css` need to outline the row, and
  // `[role="option"]` is far too broad a hook: the file pane, the settings
  // selectors and the agent/forge dropdowns all use it too. The transparent
  // border holds every row's content box on the column the palette's other
  // families are drawn from. `relative` stays because rows position their own
  // absolutely placed children against it.
  "palette-row relative border border-transparent transition-colors duration-150 ease-out",
  // A neutral fill and nothing else — the same `overlay-highlight` step the
  // Radix menu, context-menu and select rows use, so a highlighted row reads the
  // same in every list in the app. No accent (#11686) and no leading rail: see
  // `.palette-row` in `index.css` for why the rail went, and why the fill is
  // its own token.
  //
  // One row carries this at a time, and the pointer and the keyboard move the
  // same one. A row that also paints `hover:bg-*` brings back the second lit
  // row this treatment exists to rule out — move the cursor on `pointermove`
  // instead (see `SearchablePalette`'s `onHoverIndex`).
  //
  // `data-selected` is the opt-in for a list-detail browser that is NOT a
  // composite listbox — a plain list of rows, which is what the ARIA content
  // model forces once a row carries its own controls. Those rows keep
  // `aria-current` on their focusable selection button for assistive
  // technology and set this attribute on the row for the CSS. It is deliberately
  // NOT keyed on `aria-current` itself: five palettes mark their committed value
  // with `aria-current` independently of the cursor (`aria-selected`) and give
  // it a check mark, not a competing background — widening onto `aria-current`
  // lit both rows at once.
  "aria-selected:bg-overlay-highlight aria-selected:text-text-primary",
  "data-[selected=true]:bg-overlay-highlight data-[selected=true]:text-text-primary"
);

/**
 * The label that names a band of rows ("Pinned", "Scratch", "Recent").
 *
 * Same drift as the row treatment: most palettes drew it as a 10px tracked
 * uppercase whisper, while the dock launcher used 11px sentence case — so the
 * same structural element read as two different things depending on which
 * palette you opened. Padding stays out of it where a palette's list inset
 * differs; the type treatment is what has to match.
 *
 * `text-text-secondary`, not a percentage of the body colour. At 10px this is
 * small text under WCAG's ordinary 4.5:1 rule, and `text-daintree-text/40`
 * measured about 3.3:1 on the palette surface in the dark themes — below the
 * floor for a label that names which project every row beneath it belongs to.
 * The token is the theme's own answer to "muted but readable" (6.57:1 in
 * Daintree) and it is defined in all fifteen; the treatment is unchanged
 * otherwise, because the size and the tracking were never the problem.
 */
export const PALETTE_SECTION_LABEL_CLASS =
  "text-3xs font-medium tracking-wider uppercase text-text-secondary select-none";

/**
 * The keyboard-focus ring every palette control wears.
 *
 * Inset on purpose: palette surfaces clip to `overflow-hidden`, so a ring drawn
 * outside a full-width row loses its left and right sides at the dialog edge.
 * Accent here is within the restraint budget because only one element in the
 * palette can hold DOM focus at a time — it is the singleton focus anchor, not
 * a second signal competing with the roving cursor's neutral highlight.
 */
export const PALETTE_ROW_FOCUS_CLASS =
  "focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent-primary";
