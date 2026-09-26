import type { TerminalScratchpad } from "@shared/types/panel";

export const SCRATCHPAD_DEFAULT_WIDTH = 280;
export const SCRATCHPAD_MIN_WIDTH = 200;
export const SCRATCHPAD_MAX_WIDTH = 560;
/** Keyboard nudge; Shift multiplies to the coarse step. */
export const SCRATCHPAD_RESIZE_STEP = 10;
export const SCRATCHPAD_RESIZE_STEP_COARSE = 50;
/**
 * The notes ride the panel record into the project's state file on every layout
 * save, so they get a ceiling well above a page of notes and well below
 * anything that would make that save noticeable.
 */
export const SCRATCHPAD_MAX_CHARS = 20_000;

/** Folds non-finite input back to the default, or it survives as an invalid inline width. */
export function clampScratchpadWidth(width: number): number {
  if (!Number.isFinite(width)) return SCRATCHPAD_DEFAULT_WIDTH;
  return Math.min(Math.max(Math.round(width), SCRATCHPAD_MIN_WIDTH), SCRATCHPAD_MAX_WIDTH);
}

/** Whether collapsing keeps an expand control: whitespace alone is not a note. */
export function scratchpadHasContent(scratchpad: TerminalScratchpad | undefined): boolean {
  return scratchpad !== undefined && scratchpad.content.trim().length > 0;
}

/**
 * Normalize an untrusted persisted value. The snapshot schema passes unknown
 * keys through, so a hand-edited or corrupted record must fall back to "no
 * scratchpad" rather than reach the pane as a non-string or an invalid width.
 * A collapsed record with nothing in it has no expand control to come back
 * through, so it normalizes to absent as well.
 */
export function sanitizeScratchpad(value: unknown): TerminalScratchpad | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const content = "content" in value ? value.content : undefined;
  const collapsed = "collapsed" in value ? value.collapsed : undefined;
  const width = "width" in value ? value.width : undefined;
  if (typeof content !== "string") return undefined;
  const scratchpad: TerminalScratchpad = {
    content: content.slice(0, SCRATCHPAD_MAX_CHARS),
    collapsed: collapsed === true,
    ...(typeof width === "number" &&
      Number.isFinite(width) && { width: clampScratchpadWidth(width) }),
  };
  if (scratchpad.collapsed && !scratchpadHasContent(scratchpad)) return undefined;
  return scratchpad;
}

/** DOM boundary every automatic focus handoff checks before pulling focus into the terminal. */
export const SCRATCHPAD_BOUNDARY_ATTR = "data-terminal-scratchpad";

/**
 * Whether the user is writing in a Scratchpad — the given terminal's, when one
 * is named. A focus handoff that fires on its own for a pane (the pane becoming
 * selected, a dock popover's agent chrome changing, a lazily mounted input bar)
 * must leave the keyboard in that pane's notes (#12835). Scoped to the pane so
 * one pane's notes never block a handoff meant for a different pane.
 */
export function isScratchpadElement(
  element: Element | null | undefined,
  terminalId?: string
): boolean {
  const boundary = element?.closest(`[${SCRATCHPAD_BOUNDARY_ATTR}]`);
  if (!boundary) return false;
  return terminalId === undefined || boundary.getAttribute(SCRATCHPAD_BOUNDARY_ATTR) === terminalId;
}
