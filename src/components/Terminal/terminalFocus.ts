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
 * This is an *availability resolver*: it takes the surface wanted (the pane's
 * home, from the **Focus first** setting, or one a caller named) and gates it
 * on whether the hybrid input is actually focusable. The hybrid input renders
 * for live agent terminals and for normal terminals temporarily participating
 * in a Fleet broadcast; when it's missing, disabled, or the feature is turned
 * off, focus falls back to xterm.
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

export type PaneFocusAction = "preserve" | "hybridInput" | "xterm";

/**
 * Resolve what a focused pane should do with DOM focus, given the target
 * `getTerminalFocusTarget` picked and the live selection/focus state of its
 * xterm.
 *
 * The selection rule is about ownership, not about the selection itself: an
 * xterm that holds keyboard focus *and* a selection keeps both, because
 * handing focus to the input bar mid-selection is a yank the user didn't ask
 * for. A selection in an xterm that does NOT hold keyboard focus is inert —
 * the pane is being focused from elsewhere, so declining to move focus would
 * strand the keyboard on the pane the user just left (#11133). Focus does not
 * clear an xterm selection either way: `SelectionService` reacts to input and
 * buffer events, never to DOM blur.
 *
 * `preserve` therefore means "focus is already where it belongs" — callers
 * treat it as a completed handoff, not a failure. A caller that asked for the
 * hybrid input by name gets it regardless: preserving would report a handoff
 * to the surface it named that never happened.
 */
export function resolvePaneFocusAction(options: {
  focusTarget: TerminalFocusTarget;
  hasSelection: boolean;
  xtermOwnsDomFocus: boolean;
  /** The target is the surface a caller asked for, not the pane's own pick. */
  requested?: boolean;
}): PaneFocusAction {
  if (options.focusTarget !== "hybridInput") return "xterm";
  if (!options.requested && options.hasSelection && options.xtermOwnsDomFocus) return "preserve";
  return "hybridInput";
}

/**
 * What an agent pane does with focus: the surface a caller asked for, else
 * home, gated on what the pane can take right now, then on whether its xterm
 * holds a selection and the keyboard. A surface a caller asked for by name
 * skips that last check.
 *
 * The pane's own pass (`keepOwnedSurface`), run as the pane becomes selected or
 * what it can take changes, isn't an arrival anyone asked for: a keyboard
 * already on one of its usable surfaces stays there. That is what keeps a click
 * into the hybrid input of an unselected pane, or terminal typing in a pane
 * whose input bar just appeared, where the user put it.
 */
export function resolveTerminalPaneFocus(options: {
  requested: TerminalFocusTarget | null;
  home: TerminalFocusTarget;
  hasHybridInputSurface: boolean;
  isInputDisabled: boolean;
  hybridInputEnabled: boolean;
  hasSelection: boolean;
  xtermOwnsDomFocus: boolean;
  hybridInputOwnsDomFocus?: boolean;
  keepOwnedSurface?: boolean;
}): PaneFocusAction {
  const {
    requested,
    home,
    hasSelection,
    xtermOwnsDomFocus,
    hybridInputOwnsDomFocus = false,
    keepOwnedSurface = false,
    ...availability
  } = options;
  if (keepOwnedSurface && requested === null) {
    if (xtermOwnsDomFocus) return "preserve";
    if (
      hybridInputOwnsDomFocus &&
      getTerminalFocusTarget({ preferredTarget: "hybridInput", ...availability }) === "hybridInput"
    ) {
      return "preserve";
    }
  }
  const focusTarget = getTerminalFocusTarget({
    preferredTarget: requested ?? home,
    ...availability,
  });
  return resolvePaneFocusAction({
    focusTarget,
    requested: requested === focusTarget,
    hasSelection,
    xtermOwnsDomFocus,
  });
}

/**
 * Whether a pointerdown on the xterm area of an *unfocused* pane, in the grid
 * or the dock, should be swallowed before xterm sees it. Prevents stray clicks
 * from poking at cursor positions, mouse-mode handlers, or kicking off
 * selection on a pane that the user is just trying to activate; the pane then
 * hands the keyboard to its home like any other arrival.
 *
 * Intentionally narrow: only applies to the unfocused case, only for
 * non-pointer (non-link) cells, and never for the force-selection click —
 * xterm's SelectionService treats it as the override gesture to bypass PTY
 * mouse reporting and force native text selection, so the event must reach
 * xterm. That is Shift everywhere, plus Option on macOS, where
 * `macOptionClickForcesSelection` is on and xterm checks Option, not Shift.
 * The redirect to hybrid input vs xterm is *not* decided here — callers
 * consult `getTerminalFocusTarget` separately.
 */
export function shouldSuppressUnfocusedClick(options: {
  isFocused: boolean;
  isCursorPointer: boolean;
  isShiftKey: boolean;
  isAltKey?: boolean;
  isMac?: boolean;
}): boolean {
  if (options.isFocused) return false;
  if (options.isCursorPointer) return false;
  if (options.isShiftKey) return false;
  if (options.isMac && options.isAltKey) return false;
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
