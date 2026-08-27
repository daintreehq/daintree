/**
 * Shared chrome for the sidebar card's two disclosure sections (Details and
 * Active sessions).
 *
 * They are siblings and must read as siblings. Before this they used the same
 * bordered, filled well but different label type (12px sans vs 11px medium
 * muted), so two equal sections looked like two different components. One
 * label token here is what keeps them in step.
 *
 * The sidebar deliberately drops the well: the card row is already a
 * container, and nesting a second bordered plane inside it — with a third for
 * the note and a fourth for the file list — reads as a stack of cards and
 * costs roughly 34px of a 240-360px column per level. The grid card keeps the
 * well, because it sits on a wider standalone surface where containment still
 * earns its keep.
 */

/**
 * The section trigger's label. A quiet micro-label rather than a heading:
 * these name a region, they are not content, and at this size tracking is what
 * keeps uppercase legible.
 *
 * `text-secondary`, not `text-muted`: this labels an interactive disclosure,
 * and on the darkest palettes the muted tone dropped it to the weight of
 * passive metadata. The 10px uppercase size does the de-emphasis; the tone
 * does not have to as well.
 */
export const SECTION_LABEL =
  "text-[10px] font-medium uppercase tracking-[0.06em] text-text-secondary";

/**
 * Hover/press target for a flattened section trigger. Bleeds slightly past the
 * card's text column so the backplate reads as a row rather than a chip, the
 * way a sidebar list row's hover does.
 */
export const SECTION_TRIGGER_SURFACE =
  "worktree-section-button -mx-1.5 w-[calc(100%+0.75rem)] rounded-[var(--radius-md)] px-1.5";
