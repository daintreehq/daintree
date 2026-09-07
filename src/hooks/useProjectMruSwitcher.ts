import { useEffect } from "react";
import { beginSwitchTrace } from "@/utils/switchTrace";

import { switchToLastWorkspace } from "@/lib/projectHistoryNav";

export type UseProjectMruSwitcherReturn = void;

function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.closest(".xterm") !== null) return false;
  if (target.tagName === "INPUT" || target.tagName === "TEXTAREA") return true;
  if (target.isContentEditable) return true;
  return false;
}

function consumeEvent(event: KeyboardEvent): void {
  event.preventDefault();
  event.stopPropagation();
  event.stopImmediatePropagation();
}

/**
 * `Cmd+Alt+=` — toggle to the workspace this window was in before this one.
 *
 * Shift is explicitly not handled: there is no "forward" from a toggle, and
 * swallowing `Cmd+Shift+Alt+=` would leave a key that consumes the event and
 * does nothing.
 *
 * Uses a capture-phase window listener so the event fires before xterm's custom
 * key handler and before `KeybindingService` dispatches the matching action.
 * Handled events get `stopPropagation` + `preventDefault` to prevent
 * double-dispatch.
 */
export function useProjectMruSwitcher(): UseProjectMruSwitcherReturn {
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.isComposing) return;
      if (!event.metaKey || !event.altKey || event.shiftKey) return;
      if (event.code !== "Equal" && event.code !== "NumpadAdd") return;

      if (isEditableTarget(event.target)) return;

      consumeEvent(event);
      if (event.repeat) return;
      beginSwitchTrace("mru-shortcut");
      void switchToLastWorkspace();
    };

    window.addEventListener("keydown", handleKeyDown, { capture: true });

    return () => {
      window.removeEventListener("keydown", handleKeyDown, { capture: true });
    };
  }, []);
}
