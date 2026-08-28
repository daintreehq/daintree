/**
 * Shared chrome for the sidebar card's two disclosure sections (Details and
 * Active sessions).
 *
 * They are siblings and must read as siblings. Before this they used the same
 * bordered, filled well but different label type (12px sans vs 11px medium
 * muted), so two equal sections looked like two different components. One
 * label token here is what keeps them in step.
 *
 * Both sit inside the card's single content column, so every row here shares
 * one leading inset and one trailing inset no matter which section it belongs
 * to or whether it sits on the card or inside a well.
 */

/**
 * The section trigger's label. A quiet micro-label rather than a heading:
 * these name a region, they are not content.
 *
 * `text-secondary`, not `text-muted`: this labels an interactive disclosure,
 * and on the darkest palettes the muted tone dropped it to the weight of
 * passive metadata. The 11px size does the de-emphasis; the tone does not have
 * to as well.
 */
export const SECTION_LABEL = "text-2xs font-medium text-text-secondary";

/**
 * The geometry of a sidebar disclosure row — the collapsed Details trigger,
 * the collapsed sessions trigger, and the trigger at the top of an expanded
 * well — without `w-full` or the flex reset.
 *
 * One set of values for all of them, because they are peers and the only way
 * peers stay aligned is by sharing their geometry rather than each being tuned
 * to look right on its own. Earlier these differed: Details was a chip with a
 * 4px negative margin and 4px padding, sessions was a row with 12px padding,
 * and their chevrons landed on different pixels one above the other.
 *
 * It is split out from `SECTION_ROW` because the collapsed Details row cannot
 * use that one — it is a `flex-1` sibling of a trailing button group rather
 * than a full-width row — so it composes this instead. The two used to carry
 * the same values written out twice, and they drifted.
 *
 * `border border-transparent` is not decoration. When this row sits inside a
 * well its content is offset by the well's 1px border; when it sits on the
 * card it is not. Carrying an invisible border in both cases puts every row's
 * text on the same x regardless of which case it is in.
 *
 * The vertical padding is 4px, not 6: with a 16px line box that still clears
 * the 24px target floor, and the two rows it governs are the ones the card
 * spends most of its height on. Six put 27px of nothing between the branch
 * line and the commit row, against 6-14px everywhere else in the card.
 *
 * The horizontal padding is deliberately asymmetric — 6px leading, 10px
 * trailing. What leads these rows is a chevron or a plus, and a glyph carries
 * its own whitespace inside its box: padded to match the trailing edge it
 * measures equal but reads over-indented, and the label after it drifts
 * visibly away from the title and branch lines above. What trails is text or a
 * timestamp, which has no such bearing and does want the full inset. Optical
 * alignment, not metric alignment; the icon is an indicator for the row, not
 * its subject.
 */
export const SECTION_ROW_BOX =
  "rounded-[var(--radius-lg)] border border-transparent py-1 pl-1.5 pr-2.5";

/**
 * The full-width disclosure row: `SECTION_ROW_BOX` plus the width and the flex
 * reset a `<button>` needs to lay its contents out as a row. Everything a row
 * that isn't full-width shares with this one lives in the box.
 */
export const SECTION_ROW = `worktree-section-button flex w-full items-center text-left ${SECTION_ROW_BOX}`;

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
 * The grid card's well — the same object as `DISCLOSURE_WELL`, one density step
 * looser.
 *
 * It used to be a different object: `bg-surface-inset` where the sidebar had
 * `bg-overlay-soft`, and it was one of two wells on the card rather than the
 * only one. That was the visible half of the divergence. A grid card is wider,
 * not differently constructed, so what the width buys is 2px more air above the
 * well and inside its rows — not a second containment vocabulary.
 */
export const GRID_DISCLOSURE_WELL =
  "mt-2 rounded-[var(--radius-lg)] border border-border-default bg-overlay-soft";

/**
 * The two densities the card is built at, and everything that changes between
 * them.
 *
 * This exists because the alternative — a `variant === "grid"` ternary at every
 * site — is what let the two variants drift into different components. Every
 * value here is either the sidebar's, or the sidebar's plus one step of air.
 * Nothing in this table is a different *kind* of treatment, and that is the
 * point: the overview is meant to read as the sidebar at grid width, not as a
 * second design of the same card.
 *
 * The vertical step is 4px→6px. It is the smallest change that registers at a
 * 320-480px card and the largest that does not restate the row as a different
 * component. The horizontal insets do not move at all: they are optically tuned
 * against a leading glyph (see `SECTION_ROW_BOX`), and that optics does not
 * change with the card's width.
 */
export interface CardDensity {
  /** The disclosure row's box — `SECTION_ROW_BOX` at this density. */
  rowBox: string;
  /** The full-width disclosure row — `SECTION_ROW` at this density. */
  row: string;
  /** The card's one closed contour. */
  well: string;
}

const GRID_ROW_BOX = "rounded-[var(--radius-lg)] border border-transparent py-1.5 pl-1.5 pr-2.5";

export const CARD_DENSITY: Record<"sidebar" | "grid", CardDensity> = {
  sidebar: {
    rowBox: SECTION_ROW_BOX,
    row: SECTION_ROW,
    well: DISCLOSURE_WELL,
  },
  grid: {
    rowBox: GRID_ROW_BOX,
    row: `worktree-section-button flex w-full items-center text-left ${GRID_ROW_BOX}`,
    well: GRID_DISCLOSURE_WELL,
  },
};

/**
 * The card's text column, expressed relative to the content column.
 *
 * Every line in the header leads with a 14px glyph and an 8px gap, so its text
 * starts 22px in. A line that carries no glyph has to spend that 22px as
 * padding or it lands back on the glyph column and reads as a different tier
 * from the row directly above it — which is what the collapsed summary line
 * did: the same "6 files" text sat at x16 collapsed and x42 expanded, so
 * toggling a card slid it 26px sideways.
 */
export const SECTION_TEXT_COLUMN = "pl-[22px]";
