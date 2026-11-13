import type { MouseEvent } from "react";

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
 * Every chip in a pane header's row — finished, queued, driven-by,
 * rate limit, notices, subagents, the running command, the worktree branch and
 * plugin badges — shares this box, so the row reads as one line of metadata at
 * one height instead of three sizes jostling beside the title. A chip keeps its
 * own ink and, where it says something (the worktree's colour), its own edge; the size, padding and shape are not negotiable.
 *
 * 11px, one step under the pane title and the same size as the resource
 * readout at the end of the row, so metadata never outweighs the name it
 * annotates.
 */
export const HEADER_CHIP_CLASS =
  "inline-flex shrink-0 items-center gap-1 rounded-full border px-1.5 py-0.5 text-2xs leading-4";

/**
 * Ambient telemetry — context, the settled cost and tokens, CPU and memory —
 * as plain secondary text rather than a chip. A box is kept for what answers
 * the pointer or reports something unusual, so a fact never reads as a control
 * and never outweighs the title. `data-header-fact` puts a dot between two
 * facts in a row (panels.css), so a run of them reads as one line of readings.
 */
export const HEADER_FACT_CLASS =
  "inline-flex shrink-0 items-center gap-1 rounded-sm whitespace-nowrap text-2xs leading-4 text-text-secondary tabular-nums";

/**
 * The neutral surface most header chips sit on: a flat tint with no visible
 * edge, for a chip that only reports (queued, exit, when done). The edge is
 * kept for chips that answer the pointer (`HEADER_CHIP_TRIGGER_CLASS`), so a
 * control can be told from a label at rest, not only on hover. Forced colours
 * flatten the tint, so the edge comes back there.
 */
export const HEADER_CHIP_SURFACE =
  "border-transparent bg-overlay-soft text-text-secondary forced-colors:border-[CanvasText]";

/**
 * A header chip that opens a popover or a menu (subagents, notices, decisions).
 * It wears the edge a reporting chip doesn't, and hover and open lift the fill
 * one step, the same on every such chip, so a chip that answers the pointer
 * reads as a control rather than a label. Ink stays with the caller: a
 * neutral chip adds `hover:text-text-primary`, a toned one keeps its tone.
 * `aria-expanded` rather than `data-[state=open]`: a chip that is also a
 * tooltip trigger carries the tooltip's `data-state`, not the popover's.
 */
export const HEADER_CHIP_TRIGGER_CLASS =
  "border-divider transition-colors duration-150 ease-out hover:bg-overlay-medium aria-expanded:bg-overlay-medium";

/**
 * Wraps a header chip that opens a popover, so pressing it leaves the pane's
 * selection where it was. A click anywhere in a pane selects it unless the
 * click was default-prevented (`ContentPanel`), and selecting a pane sends the
 * keyboard to its home surface, which closes a non-modal popover the moment it
 * opens: on any pane but the focused one, the chip did nothing. Only clicks on
 * the chip itself are held back; clicks in the portalled popover are left
 * alone, so its own links and controls keep their defaults.
 */
export function holdPaneSelection(event: MouseEvent<HTMLElement>): void {
  if (event.target instanceof Node && event.currentTarget.contains(event.target)) {
    event.preventDefault();
  }
}
