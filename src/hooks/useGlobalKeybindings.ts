import { useEffect, useSyncExternalStore } from "react";
import { keybindingService, normalizeKeyForBinding } from "../services/KeybindingService";
import { actionService } from "../services/ActionService";
import { openPanelContextMenu } from "../lib/panelContextMenu";
import { usePanelStore } from "../store";

/**
 * Global keybinding handler that provides:
 * 1. Chord sequence support (e.g., Cmd+K Cmd+K)
 * 2. Priority-based resolution (scoped bindings override globals)
 * 3. Centralized handling to prevent multiple handlers firing
 *
 * This hook should be called once at the app root level.
 * It uses capture phase to intercept events before other handlers.
 */
export function useGlobalKeybindings(enabled: boolean = true): void {
  useEffect(() => {
    if (!enabled) return;

    const handler = (e: KeyboardEvent) => {
      // Skip repeat events
      if (e.repeat) return;

      // Skip if user is typing in an input/textarea or editable content
      // Exception: allow shortcuts with modifiers (Cmd, Ctrl)
      const target = e.target as HTMLElement;
      const isEditable =
        target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable;

      const isInTerminal = target.closest(".xterm") !== null;

      // Get the normalized key to check if it's a modifier-only keypress
      const normalizedKey = normalizeKeyForBinding(e);
      const isModifierOnly = ["Meta", "Control", "Alt", "Shift"].includes(normalizedKey);

      // Don't process modifier-only keypresses
      if (isModifierOnly) return;

      // Handle Shift+F10 and ContextMenu key for panel context menus.
      // Must be checked before the editable/terminal bailouts below.
      // Respects user overrides — if the binding is disabled, fall through.
      if (
        e.key === "ContextMenu" ||
        (e.key === "F10" && e.shiftKey && !e.ctrlKey && !e.metaKey && !e.altKey)
      ) {
        const effectiveCombo = keybindingService.getEffectiveCombo("terminal.contextMenu");
        if (effectiveCombo !== undefined) {
          e.preventDefault();
          e.stopPropagation();
          const focusedId = usePanelStore.getState().focusedId;
          if (focusedId) {
            openPanelContextMenu(focusedId);
          }
          return;
        }
      }

      // Escape cancels any pending chord — consume the event to prevent xterm leakage
      const pendingChord = keybindingService.getPendingChord();
      if (e.key === "Escape" && pendingChord) {
        e.preventDefault();
        e.stopPropagation();
        keybindingService.clearPendingChord();
        return;
      }

      // For editable contexts without modifiers, let native behavior happen
      // Exception: allow chord completion even without modifiers, and F6 for region cycling
      const hasModifier = e.metaKey || e.ctrlKey;

      if (isEditable && !hasModifier && !pendingChord && e.key !== "F6") {
        return;
      }

      // Let xterm handle its own keys except for global shortcuts with modifiers, chord completion, or F6
      if (isInTerminal && !hasModifier && !pendingChord && e.key !== "F6") {
        return;
      }

      // Use resolveKeybinding for proper chord and priority resolution
      const result = keybindingService.resolveKeybinding(e);

      if (result.shouldConsume) {
        e.preventDefault();
        e.stopPropagation();

        if (result.match) {
          // Dispatch through ActionService
          void actionService
            .dispatch(
              result.match.actionId as Parameters<typeof actionService.dispatch>[0],
              undefined,
              {
                source: "keybinding",
              }
            )
            .then((dispatchResult) => {
              if (!dispatchResult.ok) {
                console.error(
                  `[GlobalKeybinding] Action "${result.match!.actionId}" failed:`,
                  dispatchResult.error
                );
              }
            });
        }
        // If chordPrefix but no match, event is consumed to prevent terminal leakage
      }
    };

    const handleBlur = () => keybindingService.clearPendingChord();
    const handleVisibilityChange = () => {
      if (document.hidden) keybindingService.clearPendingChord();
    };

    // Use capture phase to intercept before other handlers
    window.addEventListener("keydown", handler, { capture: true });
    window.addEventListener("blur", handleBlur);
    document.addEventListener("visibilitychange", handleVisibilityChange);
    return () => {
      window.removeEventListener("keydown", handler, { capture: true });
      window.removeEventListener("blur", handleBlur);
      document.removeEventListener("visibilitychange", handleVisibilityChange);
    };
  }, [enabled]);
}

const subscribeToPendingChord = (callback: () => void) => keybindingService.subscribe(callback);
const getPendingChordSnapshot = () => keybindingService.getPendingChord();

export function usePendingChord(): string | null {
  return useSyncExternalStore(subscribeToPendingChord, getPendingChordSnapshot);
}
