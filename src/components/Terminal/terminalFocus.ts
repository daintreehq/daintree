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
 * treat it as a completed handoff, not a failure.
 */
export function resolvePaneFocusAction(options: {
  focusTarget: TerminalFocusTarget;
  hasSelection: boolean;
  xtermOwnsDomFocus: boolean;
}): PaneFocusAction {
  if (options.focusTarget !== "hybridInput") return "xterm";
  if (options.hasSelection && options.xtermOwnsDomFocus) return "preserve";
  return "hybridInput";
}

/**
 * Whether a pointerdown on the xterm area of an *unfocused* grid pane should
 * be swallowed before xterm sees it. Prevents stray clicks from poking at
 * cursor positions, mouse-mode handlers, or kicking off selection on a pane
 * that the user is just trying to activate.
 *
 * Intentionally narrow: only applies to the unfocused grid case, only for
 * non-pointer (non-link) cells, and never for a MODIFIED press. Both modifiers
 * are deliberate overrides that only mean anything if xterm sees them:
 *
 *   - shift, which xterm's SelectionService treats as "bypass PTY mouse reporting and
 *     force native text selection";
 *   - alt, which under `mouseEventsRequireAlt` (see `xtermConfig.ts`) is the opposite
 *     gesture — "give this press to the application" — and is the ONLY way to reach a
 *     TUI's own click targets. Swallowing it made that gesture unavailable on any pane
 *     the user had not already clicked once, which is exactly the pane they are most
 *     likely to be reaching into.
 *
 * A plain first press is still swallowed, and that is on purpose: on a pane the user is
 * only activating, it must not poke the application's mouse handlers or start a
 * selection they did not ask for. The second press does both.
 *
 * The redirect to hybrid input vs xterm is *not* decided here — callers
 * consult `getTerminalFocusTarget` separately.
 */
export function shouldSuppressUnfocusedClick(options: {
  location: string;
  isFocused: boolean;
  isCursorPointer: boolean;
  isShiftKey: boolean;
  isAltKey?: boolean;
}): boolean {
  if (options.location !== "grid") return false;
  if (options.isFocused) return false;
  if (options.isCursorPointer) return false;
  if (options.isShiftKey) return false;
  if (options.isAltKey === true) return false;
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

/**
 * Whether a pointerdown on xterm should record `"xterm"` as the session-wide
 * focus preference. Only a deliberate click that lands in xterm counts as the
 * explicit "I want the terminal" gesture.
 *
 * The two exclusions are independent. AT cursor routing does reach xterm, but
 * it isn't a mode switch — a screen reader reading terminal output must not
 * clobber a hybrid-input preference. `shouldSuppress` marks the activation
 * click on an unfocused grid pane, which should restore the remembered target
 * the same way `Cmd+<n>` does rather than overwrite it (#11465); a physical
 * one is swallowed before xterm sees it, and an AT-routed one is already
 * excluded by the rule above.
 *
 * Callers must pair this with *not* forcing xterm focus on the suppressed
 * path — DOM focus on xterm fires `focusin`, which records `"xterm"`
 * unconditionally and would undo the preservation.
 */
export function shouldRecordXtermFocusPreference(options: {
  isAtSynthesized: boolean;
  shouldSuppress: boolean;
}): boolean {
  return !options.isAtSynthesized && !options.shouldSuppress;
}
