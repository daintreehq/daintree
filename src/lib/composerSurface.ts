import { useMacroFocusStore } from "@/store/macroFocusStore";
import { findPanelIdForElement } from "@/lib/typeAnywhere";

// The way to a recovery takes the keyboard through a palette, a menu or the
// toolbar button that opens one, so focus landing there says nothing about
// which composer the user was working in.
const PASS_THROUGH =
  '[role="dialog"], [role="menu"], [role="toolbar"], [data-radix-popper-content-wrapper]';

let assistantLast = false;

// Whether the person has been in the Assistant at all, and which panes they
// have been in since they last were. Neither `focusedId` (pinned while the
// Assistant has the keyboard, #6959) nor the panel MRU (unchanged by a return
// to the pane it already names) can tell a return to the pane from staying in
// the Assistant.
let assistantUsed = false;
const panesUsedSinceAssistant = new Set<string>();

/**
 * Whether the Daintree Assistant was the last place the keyboard worked,
 * overlays and the toolbar aside. The assistant's own focus region clears as
 * soon as a palette opens, so it can't answer this once one has.
 */
export function wasAssistantLastFocused(): boolean {
  return assistantLast;
}

/**
 * Whether the person was in the Assistant more recently than in any of these
 * panes: the keyboard there since the keyboard or a press in any of them, so a
 * pane holding the keyboard now never loses to it. False when they haven't
 * been in the Assistant in this view.
 */
export function wasAssistantUsedAfter(paneIds: Iterable<string>): boolean {
  if (!assistantUsed) return false;
  for (const id of paneIds) {
    if (panesUsedSinceAssistant.has(id)) return false;
  }
  return true;
}

/** A pane that is gone can't be one {@link wasAssistantUsedAfter} is asked about. */
export function forgetComposerSurfacePane(paneId: string): void {
  panesUsedSinceAssistant.delete(paneId);
}

function isInAssistant(el: Element): boolean {
  return useMacroFocusStore.getState().refs.get("assistant")?.contains(el) ?? false;
}

// Anything that is neither, the toolbar or a portaled menu, leaves both as
// they were. A press in a pane counts even where focus doesn't move (its
// chrome, the pane `focusedId` already names), since it selects the pane.
function notePaneUse(el: Element): void {
  if (!assistantUsed) return;
  const paneId = findPanelIdForElement(el);
  if (paneId !== null) panesUsedSinceAssistant.add(paneId);
}

/**
 * Follows where the keyboard and pointer work, for {@link wasAssistantLastFocused}
 * and {@link wasAssistantUsedAfter}. Returns the stop.
 */
export function trackComposerSurface(): () => void {
  if (typeof document === "undefined") return () => {};
  const onFocusIn = (event: FocusEvent) => {
    const el = event.target;
    if (!(el instanceof Element)) return;
    const inAssistant = isInAssistant(el);
    if (inAssistant) {
      assistantUsed = true;
      panesUsedSinceAssistant.clear();
    } else {
      notePaneUse(el);
    }
    if (el.closest(PASS_THROUGH)) return;
    assistantLast = inAssistant;
  };
  const onPointerDown = (event: PointerEvent) => {
    const el = event.target;
    if (el instanceof Element && !isInAssistant(el)) notePaneUse(el);
  };
  document.addEventListener("focusin", onFocusIn, true);
  document.addEventListener("pointerdown", onPointerDown, { capture: true, passive: true });
  return () => {
    document.removeEventListener("focusin", onFocusIn, true);
    document.removeEventListener("pointerdown", onPointerDown, { capture: true });
    assistantLast = false;
    assistantUsed = false;
    panesUsedSinceAssistant.clear();
  };
}
