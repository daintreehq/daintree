import { focusPanelInput } from "@/components/Panel/panelFocusRegistry";
import { hasUsefulFocus } from "@/lib/typeAnywhere";
import { usePanelStore } from "@/store/panelStore";
import type { TerminalFocusTarget } from "./terminalFocus";

/**
 * "Focus this agent pane's hybrid input" (or its terminal), said by whoever
 * steers the keyboard into a pane — a drop, type-anywhere, a restore — for
 * that pane alone: every later arrival still lands on home.
 *
 * At most one intent is current per view. An explicit request is one; so is
 * the surface a pane's own focus pass settled on when it arrived, which a
 * hybrid input still loading its lazy chunk takes when it mounts (#10541). Only
 * an explicit request overrides where the pane would otherwise go.
 *
 * An intent stays current while its pane stays selected and nothing newer
 * happens: a newer request, a press anywhere in the window, the selection
 * moving to another pane, or focus landing on something else that takes typing
 * (another pane, the other surface, the Scratchpad, a dialog's field).
 *
 * The epoch cancels deferred focus work in general, requested or not: a frame
 * scheduled under one epoch does nothing once a newer request, a user press, or
 * focus landing on another typing surface has moved it, so a stale grab can't
 * drag the keyboard back from where the user went (#8487). The selection moving
 * on ends the intent but not the epoch: the pane it left calls off its own
 * frames, and a reconcile after a panel closes is no reason to call off anyone
 * else's, such as the assistant's.
 */
interface PaneFocusIntent {
  paneId: string;
  surface: TerminalFocusTarget;
  explicit: boolean;
  /** Asked by dictation, which is about to write at the composer's caret (#14770). */
  forDictation: boolean;
  /**
   * Where the composer's caret goes when it takes the keyboard, read then: the
   * dictation key stopping a dictation takes the person back to it with the
   * caret after its words (#14791). Used once.
   */
  caret: (() => number | null) | null;
}

let epoch = 0;
let current: PaneFocusIntent | null = null;
let stopWatching: (() => void) | null = null;
let pressListener: (() => void) | null = null;

function isOnSurface(el: Element, intent: Pick<PaneFocusIntent, "paneId" | "surface">): boolean {
  if (intent.surface === "hybridInput") {
    return (
      el.closest("[data-hybrid-input-root]")?.getAttribute("data-hybrid-input-root") ===
      intent.paneId
    );
  }
  return (
    el.closest(".xterm") !== null &&
    el.closest("[data-panel-id]")?.getAttribute("data-panel-id") === intent.paneId
  );
}

function clearIntent(): void {
  current = null;
  stopWatching?.();
  stopWatching = null;
}

/** Something newer happened: the intent ends, and so does every grab scheduled before it. */
function supersede(): void {
  epoch += 1;
  clearIntent();
}

function watchPresses(): void {
  if (pressListener || typeof window === "undefined") return;
  pressListener = supersede;
  // Capture, so the press is counted before any handler it reaches schedules
  // focus work of its own: that work then belongs to the new epoch.
  window.addEventListener("pointerdown", pressListener, { capture: true, passive: true });
}

function watchIntent(): void {
  if (stopWatching) return;
  const unsubscribe = usePanelStore.subscribe((state, prev) => {
    if (state.focusedId === prev.focusedId) return;
    if (current && state.focusedId !== current.paneId) clearIntent();
  });
  const onFocusIn = (e: FocusEvent) => {
    const el = e.target;
    if (!current || !(el instanceof Element)) return;
    if (hasUsefulFocus(el) && !isOnSurface(el, current)) supersede();
  };
  document.addEventListener("focusin", onFocusIn, true);
  stopWatching = () => {
    unsubscribe();
    document.removeEventListener("focusin", onFocusIn, true);
  };
}

/**
 * Ask `paneId` to focus `surface`, and try it now. True when focus is on the
 * surface or its grab is scheduled for the next frame, the registry's own
 * contract; false when nothing could take it yet. A hybrid input still loading
 * keeps the request and takes it when it mounts, if it is still current.
 */
export function requestPaneFocus(
  paneId: string,
  surface: TerminalFocusTarget,
  options: { forDictation?: boolean; caret?: () => number | null } = {}
): boolean {
  watchPresses();
  epoch += 1;
  current = {
    paneId,
    surface,
    explicit: true,
    forDictation: options.forDictation === true,
    caret: options.caret ?? null,
  };
  watchIntent();
  return focusPanelInput(paneId, surface);
}

/**
 * The pane's own focus pass settled on `surface`. Remembered only so a late
 * hybrid input knows it was wanted; it never outranks an explicit request for
 * the same pane, and it supersedes no deferred work.
 */
export function holdPaneFocus(paneId: string, surface: TerminalFocusTarget): void {
  if (current?.explicit && current.paneId === paneId) return;
  watchPresses();
  current = { paneId, surface, explicit: false, forDictation: false, caret: null };
  watchIntent();
}

/** Which of `paneId`'s typing surfaces holds the keyboard right now, if either. */
export function paneSurfaceHoldingFocus(paneId: string): TerminalFocusTarget | null {
  const el = document.activeElement;
  if (!el) return null;
  if (isOnSurface(el, { paneId, surface: "hybridInput" })) return "hybridInput";
  if (isOnSurface(el, { paneId, surface: "xterm" })) return "xterm";
  return null;
}

/** The surface an explicit, still-current request asks `paneId` to focus, or null. */
export function requestedPaneSurface(paneId: string): TerminalFocusTarget | null {
  return current?.explicit && current.paneId === paneId ? current.surface : null;
}

/**
 * Whether the explicit, still-current request for `paneId` came from dictation,
 * whose words go in at the composer's caret: the grab leaves that caret alone.
 */
export function requestedForDictation(paneId: string): boolean {
  return current?.explicit === true && current.paneId === paneId && current.forDictation;
}

/**
 * The caret the still-current dictation request for `paneId` asked for, taken:
 * a later grab of the same request leaves the caret where the user put it.
 */
export function takeRequestedDictationCaret(paneId: string): number | null {
  if (!current?.explicit || current.paneId !== paneId || !current.forDictation) return null;
  const caret = current.caret;
  current.caret = null;
  return caret?.() ?? null;
}

/** The surface `paneId` should still end up on, requested or settled on arrival, or null. */
export function pendingPaneSurface(paneId: string): TerminalFocusTarget | null {
  return current?.paneId === paneId ? current.surface : null;
}

/** Captured when deferred focus work is scheduled; see {@link isFocusEpochCurrent}. */
export function captureFocusEpoch(): number {
  watchPresses();
  return epoch;
}

/** False once a newer request or a user press has superseded work scheduled at `captured`. */
export function isFocusEpochCurrent(captured: number): boolean {
  return captured === epoch;
}

export function _resetPaneFocusRequestsForTesting(): void {
  clearIntent();
  if (pressListener) {
    window.removeEventListener("pointerdown", pressListener, { capture: true });
    pressListener = null;
  }
  // Advanced rather than zeroed, so an epoch captured before the reset can't
  // read as current after it.
  epoch += 1;
}
