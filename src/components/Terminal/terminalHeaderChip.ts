/**
 * The keyboard ring every focusable control in a terminal pane's header wears —
 * the chips beside the title as well as the pane's own buttons (`PanelHeader`
 * spells the same recipe inline). Outline rather than ring so it survives
 * forced colours, and offset so it clears the chip's own border.
 */
export const HEADER_CHIP_FOCUS_CLASS =
  "focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent-primary";
