import { useEffect } from "react";

import { switchProjectByHistory, type ProjectHistoryDirection } from "@/lib/projectHistoryNav";

export type UseProjectMruSwitcherReturn = void;

function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.closest(".xterm") !== null) return false;
  if (target.tagName === "INPUT" || target.tagName === "TEXTAREA") return true;
  if (target.isContentEditable) return true;
  return false;
}

function getTriggerDirection(event: KeyboardEvent): ProjectHistoryDirection | null {
  if (event.code === "Equal" || event.code === "NumpadAdd") {
    return event.shiftKey ? "forward" : "back";
  }
  return null;
}

function consumeEvent(event: KeyboardEvent): void {
  event.preventDefault();
  event.stopPropagation();
  event.stopImmediatePropagation();
}

/**
 * Back/forward navigation over the projects this window has visited.
 *
 * `Cmd+Alt+=` goes back, `Cmd+Shift+Alt+=` goes forward. Both walk a real
 * history stack owned by the main process, so a third project is reachable —
 * the previous recency walk could only ever bounce between two.
 *
 * Uses capture-phase window listeners so the event fires before xterm's
 * custom key handler and before `KeybindingService` dispatches the matching
 * action. Call `stopPropagation` + `preventDefault` on handled events to
 * prevent double-dispatch.
 */
export function useProjectMruSwitcher(): UseProjectMruSwitcherReturn {
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.isComposing) return;
      if (!event.metaKey || !event.altKey) return;
      const direction = getTriggerDirection(event);
      if (!direction) return;

      if (isEditableTarget(event.target)) return;

      consumeEvent(event);
      if (event.repeat) return;
      void switchProjectByHistory(direction);
    };

    window.addEventListener("keydown", handleKeyDown, { capture: true });

    return () => {
      window.removeEventListener("keydown", handleKeyDown, { capture: true });
    };
  }, []);
}
