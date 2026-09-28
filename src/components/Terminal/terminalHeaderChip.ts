/**
 * The keyboard ring every focusable control in a terminal pane's header wears —
 * the chips beside the title as well as the pane's own buttons (`PanelHeader`
 * spells the same recipe inline). Outline rather than ring so it survives
 * forced colours, and inset because both hosts clip: the pane header's title
 * group and the assistant footer are `overflow-hidden` with no room outside.
 */
export const HEADER_CHIP_FOCUS_CLASS =
  "focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent-primary";

/**
 * Every chip in a pane header's row — finished, hibernated, queued, driven-by,
 * rate limit, notices, subagents, the running command, the worktree branch and
 * plugin badges — shares this box, so the row reads as one line of metadata at
 * one height instead of three sizes jostling beside the title. A chip keeps its
 * own ink and, where it says something (the hibernated dash, the worktree's
 * colour), its own edge; the size, padding and shape are not negotiable.
 *
 * 11px, one step under the pane title and the same size as the resource
 * readout at the end of the row, so metadata never outweighs the name it
 * annotates.
 */
export const HEADER_CHIP_CLASS =
  "inline-flex shrink-0 items-center gap-1 rounded-full border px-1.5 py-0.5 text-2xs leading-4";

/** The neutral surface most header chips sit on. */
export const HEADER_CHIP_SURFACE = "border-divider bg-overlay-soft text-text-secondary";
