import { useEffect, useSyncExternalStore } from "react";
import { keybindingService, normalizeKeyForBinding } from "../services/KeybindingService";
import { actionService } from "../services/ActionService";
import { logError } from "@/utils/logger";
import { dispatchEscape, hasHandlers } from "@/lib/escapeStack";
import { usePaletteStore, usePanelStore } from "../store";

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

      const activePaletteId = usePaletteStore.getState().activePaletteId;
      const hasModalDialog = document.querySelector('[role="dialog"][aria-modal="true"]') !== null;
      if (
        e.key === "Escape" &&
        hasHandlers() &&
        (activePaletteId !== null || (!isEditable && (hasModalDialog || !isInTerminal)))
      ) {
        e.preventDefault();
        e.stopPropagation();
        dispatchEscape();
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
      // A single-character key (letter, digit, punctuation, Space) is text input
      // that belongs to the terminal/editor — even if it happens to match a
      // focus-region rebind. Only non-text keys (F-keys, arrows, Home/End/etc.)
      // may bypass the editable/terminal bailouts as a focus-region escape.
      // Length check first: it short-circuits the combo lookup/parse work in
      // isFocusRegionEvent for ordinary printable typing.
      const isFocusRegionNonTextKey = e.key.length !== 1 && isFocusRegionEvent(e);
      const isTerminalTabInput =
        isInTerminal &&
        (e.key === "Tab" || e.code === "Tab" || e.keyCode === 9) &&
        !e.ctrlKey &&
        !e.altKey &&
        !e.metaKey;

      if (isEditable && !hasModifier && !pendingChord && !isFocusRegionNonTextKey) {
        return;
      }

      // Tab and Shift+Tab are xterm-owned input for completion/TUI navigation.
      // Do not let focus-region rebinds or native focus traversal steal them
      // before xterm's key handler has a chance to emit the terminal sequence.
      if (isTerminalTabInput && !pendingChord) {
        return;
      }

      // Let xterm handle its own keys except for global shortcuts with modifiers,
      // chord completion, or region focus. Bare keys (like X for fleet arming)
      // are blocked inside terminals so they don't steal typing — scoped
      // bindings only match when focus is outside .xterm.
      if (isInTerminal && !hasModifier && !pendingChord && !isFocusRegionNonTextKey) {
        return;
      }

      // Use resolveKeybinding for proper chord and priority resolution
      const result = keybindingService.resolveKeybinding(e);

      if (result.shouldConsume) {
        e.preventDefault();
        e.stopPropagation();

        if (result.match) {
          // Cmd+W resolves to terminal.close, but where it actually lands
          // depends on focus: the Daintree Assistant closes itself, an open
          // dialog/palette dismisses its topmost layer, and a focused grid or
          // dock panel closes that panel. See the branches below.
          if (result.match.actionId === "terminal.close") {
            // Element (not HTMLElement) — only closest() is needed below, and
            // an unchecked HTMLElement cast trips no-unsafe-type-assertion.
            const active = document.activeElement;
            // Cmd+W inside the Daintree Assistant closes the assistant itself.
            // Its escape handler intentionally bails when the embedded xterm /
            // CodeMirror has focus (so a bare Escape reaches the running PTY),
            // which would otherwise swallow Cmd+W and leave the panel open
            // (#10509). Route to help.togglePanel — focus is inside the aside,
            // so its open-and-focused branch closes the panel.
            if (active?.closest("#daintree-assistant-panel") != null) {
              void actionService
                .dispatch("help.togglePanel", undefined, { source: "keybinding" })
                .then((dispatchResult) => {
                  if (!dispatchResult.ok) {
                    logError('[GlobalKeybinding] Action "help.togglePanel" failed', undefined, {
                      error: dispatchResult.error,
                    });
                  }
                });
              return;
            }
            // When a dialog/palette keeps an escape handler registered, route
            // Cmd+W to the escape stack so it dismisses the topmost layer
            // instead of falling through to the terminal — unless focus is
            // inside a grid or dock panel, where Cmd+W must close that panel.
            if (hasHandlers()) {
              const isFocusInsidePanel =
                active?.closest("[data-panel-location='grid'],[data-panel-location='dock']") !=
                null;
              if (!isFocusInsidePanel) {
                dispatchEscape();
                return;
              }
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
