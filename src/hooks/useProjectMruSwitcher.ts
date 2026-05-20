import { useEffect } from "react";

import { switchProjectByMruDirection, type ProjectMruCycleDirection } from "@/lib/projectMruSwitch";

export type UseProjectMruSwitcherReturn = void;

function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.closest(".xterm") !== null) return false;
  if (target.tagName === "INPUT" || target.tagName === "TEXTAREA") return true;
  if (target.isContentEditable) return true;
  return false;
}

function getTriggerDirection(event: KeyboardEvent): ProjectMruCycleDirection | null {
  if (event.code === "Equal" || event.code === "NumpadAdd") {
    return event.shiftKey ? "newer" : "older";
  }
  return null;
}

function consumeEvent(event: KeyboardEvent): void {
  event.preventDefault();
  event.stopPropagation();
  event.stopImmediatePropagation();
}

/**
 * Immediate MRU project switcher.
 *
 * `Cmd+Alt+=` cycles forward (most-recent non-current project).
 * `Cmd+Shift+Alt+=` inverts direction and cycles backward (least-recent
 * non-current project).
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
      void switchProjectByMruDirection(direction);
    };

    window.addEventListener("keydown", handleKeyDown, { capture: true });

    return () => {
      window.removeEventListener("keydown", handleKeyDown, { capture: true });
    };
  }, []);
}
