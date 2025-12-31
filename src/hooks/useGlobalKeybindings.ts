import { useEffect } from "react";
import { keybindingService, normalizeKeyForBinding } from "../services/KeybindingService";
import { actionService } from "../services/ActionService";

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

      // For editable contexts without modifiers, let native behavior happen
      const hasModifier = e.metaKey || e.ctrlKey;
      if (isEditable && !hasModifier) {
        return;
      }

      // Let xterm handle its own keys except for global shortcuts with modifiers
      if (isInTerminal && !hasModifier) {
        return;
      }

      // Use findMatchingAction for proper chord and priority resolution
      const match = keybindingService.findMatchingAction(e);

      if (match) {
        e.preventDefault();
        e.stopPropagation();

        // Dispatch through ActionService
        void actionService
          .dispatch(match.actionId as Parameters<typeof actionService.dispatch>[0], undefined, {
            source: "keybinding",
          })
          .then((result) => {
            if (!result.ok) {
              console.error(`[GlobalKeybinding] Action "${match.actionId}" failed:`, result.error);
            }
          });
      }
    };

    // Use capture phase to intercept before other handlers
    window.addEventListener("keydown", handler, { capture: true });
    return () => window.removeEventListener("keydown", handler, { capture: true });
  }, [enabled]);
}

/**
 * Hook to display the current pending chord state.
 * Useful for showing a chord indicator in the UI.
 */
export function usePendingChord(): string | null {
  return keybindingService.getPendingChord();
}
