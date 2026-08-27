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
 *
 * Active sessions is the one exception, and it is not a well: it is the card's
 * footer, a full-bleed recessed tray rendered as a sibling of the body row
 * (see WorktreeCard). Flattening it along with the rest removed the only thing
 * separating two cards in a full-bleed list, which is what #11992 traded away
 * without meaning to.
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
export const SECTION_LABEL = "text-[11px] font-medium text-text-secondary";

/**
 * A sidebar disclosure row — the collapsed Details trigger, the collapsed
 * sessions trigger, and the trigger at the top of an expanded well.
 *
 * One class for all of them, because they are peers and the only way peers
 * stay aligned is by sharing their geometry rather than each being tuned to
 * look right on its own. Earlier these differed: Details was a chip with a 4px
 * negative margin and 4px padding, sessions was a row with 12px padding, and
 * their chevrons landed on different pixels one above the other.
 *
 * `border border-transparent` is not decoration. When this row sits inside a
 * well its content is offset by the well's 1px border; when it sits on the
 * card it is not. Carrying an invisible border in both cases puts every row's
 * text on the same x regardless of which case it is in.
 *
 * The padding is deliberately asymmetric — 6px leading, 10px trailing. What
 * leads these rows is a chevron or a plus, and a glyph carries its own
 * whitespace inside its box: padded to match the trailing edge it measures
 * equal but reads over-indented, and the label after it drifts visibly away
 * from the title and branch lines above. What trails is text or a timestamp,
 * which has no such bearing and does want the full inset. Optical alignment,
 * not metric alignment; the icon is an indicator for the row, not its
 * subject.
 */
export const SECTION_ROW =
  "worktree-section-button flex w-full items-center rounded-[var(--radius-lg)] border border-transparent py-1.5 pl-1.5 pr-2.5 text-left";

/**
 * The disclosure well — the card's one fill, and the only closed contour
 * inside it. Holds an expanded Details, and holds sessions in every state.
 *
 * This is a restoration, and the reasoning matters because it was removed once
 * for good reasons. #11992 flattened it away as a nested card, which it is;
 * but it was also the only thing separating two cards in a full-bleed list,
 * and without it they merged. Every flat replacement tried since — a recessed
 * full-bleed tray, then matching title and footer bands — made that worse, for
 * one reason: a painted region touching both card edges overrides proximity,
 * so it binds to whatever is adjacent. A band at the bottom of one card reads
 * equally as the header of the next.
 *
 * A well cannot do that. Its inset and its perimeter close it, so it belongs
 * unambiguously to the card whose padding it sits inside. That is what no
 * amount of tinting could buy the flat versions.
 *
 * Its step above the card is the thing to protect. Softening it to
 * `border-subtle`/`overlay-subtle` on the theory that the card's new surface
 * would carry containment cost it most of that step: measured on the selected
 * card the well sat 8 levels above the card before and 3 after, because the
 * well came down while the card went up. Three levels is not a container, and
 * the whole card read washed out. Keep the delta, not the token.
 */
export const DISCLOSURE_WELL =
  "mt-1.5 rounded-[var(--radius-lg)] border border-border-default bg-overlay-soft";

/**
 * The grid card's well. It sits on a wider standalone surface, so it keeps the
 * heavier containment that reads correctly at that size.
 */
export const GRID_SESSION_WELL =
  "mt-3 rounded-[var(--radius-lg)] border border-border-default bg-surface-inset";
