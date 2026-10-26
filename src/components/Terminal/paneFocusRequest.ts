import { focusPanelInput } from "@/components/Panel/panelFocusRegistry";
import { hasUsefulFocus } from "@/lib/typeAnywhere";
import { usePanelStore } from "@/store/panelStore";
import type { TerminalFocusTarget } from "./terminalFocus";

/**
 * "Focus this agent pane's hybrid input" (or its terminal), said by whoever
 * steers the keyboard into a pane — a drop, type-anywhere — instead of
 * rewriting the shared `preferredTerminalFocusTarget` that every later arrival
 * reads.
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
 * scheduled under one epoch does nothing once a newer request or a user press
 * has moved it, so a stale grab can't drag the keyboard back (#8487).
 */
interface PaneFocusIntent {
  paneId: string;
  surface: TerminalFocusTarget;
  explicit: boolean;
}

let epoch = 0;
let current: PaneFocusIntent | null = null;
let stopWatching: (() => void) | null = null;
let pressListener: (() => void) | null = null;

function isOnSurface(el: Element, intent: PaneFocusIntent): boolean {
  if (intent.surface === "hybridInput") {
    return el.closest("[data-hybrid-input-root]")?.getAttribute("data-hybrid-input-root") === intent.paneId;
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

function watchPresses(): void {
  if (pressListener || typeof window === "undefined") return;
  pressListener = () => {
    epoch += 1;
    clearIntent();
  };
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
    if (hasUsefulFocus(el) && !isOnSurface(el, current)) clearIntent();
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
export function requestPaneFocus(paneId: string, surface: TerminalFocusTarget): boolean {
  watchPresses();
  epoch += 1;
  current = { paneId, surface, explicit: true };
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
  current = { paneId, surface, explicit: false };
  watchIntent();
}

/** The surface an explicit, still-current request asks `paneId` to focus, or null. */
export function requestedPaneSurface(paneId: string): TerminalFocusTarget | null {
  return current?.explicit && current.paneId === paneId ? current.surface : null;
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
