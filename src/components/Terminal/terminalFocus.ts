export type TerminalFocusTarget = "hybridInput" | "xterm";

export function shouldShowHybridInputBar(options: {
  hasAgentIdentity: boolean;
  hybridInputEnabled: boolean;
  isFleetArmed: boolean;
  fleetSize: number;
}): boolean {
  return (
    options.hybridInputEnabled &&
    (options.hasAgentIdentity || (options.isFleetArmed && options.fleetSize >= 2))
  );
}

/**
 * Resolve which child component should receive focus when the terminal pane
 * gains focus.
 *
 * This is an *availability resolver*: it takes the user's current preference
 * and gates it on whether the hybrid input is actually focusable. The hybrid
 * input renders for live agent terminals and for normal terminals temporarily
 * participating in a Fleet broadcast; when it's missing, disabled, or the
 * feature is turned off, focus falls back to xterm.
 *
 * `preferredTarget` is session state owned by `panelStore` — it tracks which
 * sub-element the user is currently using so navigation (Cmd-Opt-Arrow) stays
 * in the same mode across panes.
 */
export function getTerminalFocusTarget(options: {
  preferredTarget: TerminalFocusTarget;
  hasHybridInputSurface: boolean;
  isInputDisabled: boolean;
  hybridInputEnabled: boolean;
}): TerminalFocusTarget {
  if (
    options.preferredTarget === "hybridInput" &&
    options.hasHybridInputSurface &&
    !options.isInputDisabled &&
    options.hybridInputEnabled
  ) {
    return "hybridInput";
  }
  return "xterm";
}

/**
 * Whether a pointerdown on the xterm area of an *unfocused* grid pane should
 * be swallowed before xterm sees it. Prevents stray clicks from poking at
 * cursor positions, mouse-mode handlers, or kicking off selection on a pane
 * that the user is just trying to activate.
 *
 * Intentionally narrow: only applies to the unfocused grid case, only for
 * non-pointer (non-link) cells, and never for shift+click — xterm's
 * SelectionService treats shift as the override gesture to bypass PTY mouse
 * reporting and force native text selection, so the event must reach xterm.
 * The redirect to hybrid input vs xterm is *not* decided here — callers
 * consult `getTerminalFocusTarget` separately.
 */
export function shouldSuppressUnfocusedClick(options: {
  location: string;
  isFocused: boolean;
  isCursorPointer: boolean;
  isShiftKey: boolean;
}): boolean {
  if (options.location !== "grid") return false;
  if (options.isFocused) return false;
  if (options.isCursorPointer) return false;
  if (options.isShiftKey) return false;
  return true;
}

/**
 * Whether an unfocused-pane pointerdown is likely synthesized by an assistive
 * technology (VoiceOver/NVDA cursor routing) rather than a physical pointing
 * device. AT-synthesized events are indistinguishable from real clicks by
 * their own properties in Chromium (`isTrusted` is true, `pointerType` is
 * "mouse"), so we infer it behaviourally: a physical mouse/trackpad emits
 * continuous `pointermove` immediately before a click, whereas AT routing
 * fires a bare `pointerdown` with no preceding move.
 *
 * When likely AT-synthesized, callers must NOT `stopPropagation` or
 * `setPointerCapture` — doing so swallows the routing event and breaks screen
 * reader cursor positioning. `lastMoveAt`/`now` use the same monotonic event
 * `timeStamp` clock; `lastMoveAt` is null when no move has been recorded.
 */
export function isLikelyAtSynthesizedPointer(
  lastMoveAt: number | null,
  now: number,
  thresholdMs = 100
): boolean {
  if (lastMoveAt === null) return true;
  return now - lastMoveAt > thresholdMs;
}

export type TerminalFocusEscapeDirection = "next" | "prev";

/**
 * Resolve whether a keydown inside a focused xterm should escape terminal
 * focus to an adjacent macro region, and in which direction.
 *
 * Tab is an *additive* escape path alongside F6 (handled separately) so
 * keyboard-only users aren't trapped — xterm otherwise transmits Tab to the
 * PTY as `\t`. Returns null for any other key, for Tab during IME composition,
 * and for Tab with Ctrl/Alt/Meta held (those reach the TUI or global
 * keybindings). Plain Tab moves to the next region; Shift+Tab the previous.
 */
export function resolveTerminalTabEscape(event: {
  key: string;
  shiftKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  metaKey: boolean;
  isComposing: boolean;
  keyCode: number;
}): TerminalFocusEscapeDirection | null {
  if (event.key !== "Tab") return null;
  if (event.isComposing || event.keyCode === 229) return null;
  if (event.ctrlKey || event.altKey || event.metaKey) return null;
  return event.shiftKey ? "prev" : "next";
}
