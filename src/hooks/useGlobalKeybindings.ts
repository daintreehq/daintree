import { useEffect, useSyncExternalStore } from "react";
import { keybindingService, normalizeKeyForBinding } from "../services/KeybindingService";
import { actionService } from "../services/ActionService";
import { logError } from "@/utils/logger";
import { dispatchEscape, hasHandlers } from "@/lib/escapeStack";
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

    // Region-focus bypass: let the user's current focusRegion bindings escape
    // the editable/.xterm bailouts, even when the user has rebound them away
    // from the default F6 / Shift+F6. Match the full combo via matchesEvent so
    // a Ctrl+F6 rebind doesn't accidentally let bare F6 through.
    const isFocusRegionEvent = (e: KeyboardEvent): boolean => {
      const next = keybindingService.getEffectiveCombo("nav.focusRegion.next");
      if (next && keybindingService.matchesEvent(e, next)) return true;
      const prev = keybindingService.getEffectiveCombo("nav.focusRegion.prev");
      if (prev && keybindingService.matchesEvent(e, prev)) return true;
      return false;
    };

    const handler = (e: KeyboardEvent) => {
      // Skip repeat events
      if (e.repeat) return;

      // During IME composition, let the browser/IME own the event lifecycle.
      // keyCode 229 is Chromium's "Process" key signal during active composition
      // where isComposing may not yet be set on the first keydown.
      if (e.isComposing || e.keyCode === 229) return;

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

      // Dead-key keydowns (accent layout first-press, e.g. ´ on macOS Romance
      // layouts) emit `key === "Dead"` and aren't a valid chord step on any
      // layout. Bail entirely so they neither start nor clear a chord.
      if (e.key === "Dead") return;

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
            void actionService.dispatch(
              "terminal.contextMenu",
              { terminalId: focusedId },
              { source: "keybinding" }
            );
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

      // Backspace pops the last key off the pending chord. The current chord buffer
      // holds a single token, so a pop empties it. During IME composition, bail
      // out entirely — otherwise the resolveKeybinding fallthrough below would
      // silently clear the chord while the user is mid-composition.
      if (e.key === "Backspace" && pendingChord) {
        if (e.isComposing) return;
        e.preventDefault();
        e.stopPropagation();
        keybindingService.popPendingChord();
        return;
      }

      // For editable contexts without modifiers, let native behavior happen.
      // Exception: chord completion, region-focus cycling (default F6 / Shift+F6,
      // user-rebindable), and bare keys that are scope-gated (e.g. X in
      // worktreeGrid scope for fleet arming). Scope-gated bindings are checked
      // below in resolveKeybinding → canExecute.
      const hasModifier = e.metaKey || e.ctrlKey;
      const isFocusRegion = isFocusRegionEvent(e);

      if (isEditable && !hasModifier && !pendingChord && !isFocusRegion) {
        return;
      }

      // Let xterm handle its own keys except for global shortcuts with modifiers,
      // chord completion, or region focus. Bare keys (like X for fleet arming)
      // are blocked inside terminals so they don't steal typing — scoped
      // bindings only match when focus is outside .xterm.
      if (isInTerminal && !hasModifier && !pendingChord && !isFocusRegion) {
        return;
      }

      // Use resolveKeybinding for proper chord and priority resolution
      const result = keybindingService.resolveKeybinding(e);

      if (result.shouldConsume) {
        e.preventDefault();
        e.stopPropagation();

        if (result.match) {
          // When a dialog/palette is open, route Cmd+W to the escape stack so it
          // dismisses the topmost layer instead of falling through to the terminal.
          // Skip this diversion when focus is inside a grid panel — persistent
          // docks like the assistant keep an escape handler registered the whole
          // time they are open, but Cmd+W from a focused grid panel must close
          // that panel rather than the dock.
          if (result.match.actionId === "terminal.close" && hasHandlers()) {
            const active = document.activeElement as HTMLElement | null;
            const isFocusInsideGridPanel = active?.closest("[data-panel-location='grid']") != null;
            if (!isFocusInsideGridPanel) {
              dispatchEscape();
              return;
            }
          }

          // Dispatch through ActionService
          void actionService
            .dispatch(result.match.actionId, undefined, {
              source: "keybinding",
            })
            .then((dispatchResult) => {
              if (!dispatchResult.ok) {
                logError(
                  `[GlobalKeybinding] Action "${result.match!.actionId}" failed`,
                  undefined,
                  { error: dispatchResult.error }
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

const subscribeToLastInvalidKey = (callback: () => void) => keybindingService.subscribe(callback);
const getLastInvalidKeySnapshot = () => keybindingService.getLastInvalidKey();

export function useLastInvalidKey(): string | null {
  return useSyncExternalStore(subscribeToLastInvalidKey, getLastInvalidKeySnapshot);
}
