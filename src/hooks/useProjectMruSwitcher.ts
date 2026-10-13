import { useEffect } from "react";
import { beginSwitchTrace } from "@/utils/switchTrace";

import { switchToLastWorkspace } from "@/lib/projectHistoryNav";
import { keybindingService } from "@/services/KeybindingService";

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

const ACTION_ID = "project.mruCycleOlder";

/**
 * Numpad `+` sits where `=` does on the main row and has always toggled too. The
 * matcher reads the physical key, so it is asked about the main-row key the
 * binding names.
 */
function asMainRowEqual(event: KeyboardEvent): KeyboardEvent {
  if (event.code !== "NumpadAdd") return event;
  return new KeyboardEvent("keydown", {
    key: "=",
    code: "Equal",
    metaKey: event.metaKey,
    ctrlKey: event.ctrlKey,
    altKey: event.altKey,
    shiftKey: event.shiftKey,
  });
}

/** The binding is the only owner: a rebound or unbound toggle no longer fires on the default keys. */
function matchesToggleBinding(event: KeyboardEvent): boolean {
  const combos = keybindingService.getEffectiveCombos(ACTION_ID);
  if (combos.length === 0) return false;
  const candidate = asMainRowEqual(event);
  return combos.some((combo) => keybindingService.matchesEvent(candidate, combo));
}

/**
 * `Cmd+Alt+=` by default — toggle to the workspace this window was in before this one.
 *
 * Whatever `project.mruCycleOlder` is bound to, read from the binding on each
 * press, so a rebind or an unbind takes effect here as everywhere else. Shift is
 * not handled by the default: there is no "forward" from a toggle.
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
      if (!matchesToggleBinding(event)) return;

      if (isEditableTarget(event.target)) return;
      if (keybindingService.isCapturingShortcut()) return;

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
