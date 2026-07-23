import { isMac } from "@/lib/platform";

/**
 * Terminal-first key ownership policy, shared by the window capture handler
 * (useGlobalKeybindings) and the xterm custom key handler (XtermAdapter).
 * Both layers must agree: a key reserved here is never resolved as an app
 * shortcut while a terminal has focus — it belongs to the PTY.
 */

// Readline/emacs-style Ctrl+key bindings that TUIs depend on. On Windows/Linux
// these collide with Cmd+<key> app bindings (Ctrl is the primary modifier
// there), so the capture handler must exempt them BEFORE resolveKeybinding —
// the xterm-side allowlist alone cannot protect a key the window capture
// handler already consumed. j/l/t/y are as load-bearing as the rest
// (accept-line, clear-screen, transpose, yank) and collide with the global
// Cmd+J/L/T/Y defaults (fleet.armFocused, help.togglePanel,
// terminal.duplicate, fleet.accept).
export const TUI_KEYBINDS = new Set([
  ...["p", "n", "r", "f", "b", "a", "e", "k", "u", "w", "h", "d"],
  ...["j", "l", "t", "y"],
]);

export function isTuiReservedKey(event: KeyboardEvent): boolean {
  return (
    event.ctrlKey &&
    !event.shiftKey &&
    !event.metaKey &&
    !event.altKey &&
    // Lowercase so Caps Lock (key "W" with shiftKey false) can't leak a
    // reserved key through to app-shortcut resolution.
    TUI_KEYBINDS.has(event.key.length === 1 ? event.key.toLowerCase() : event.key)
  );
}

/**
 * Standard terminal clipboard conventions on Windows/Linux: Ctrl+Shift+C /
 * Ctrl+Shift+V and Shift+Insert (pastes the CLIPBOARD selection — the async
 * clipboard API doesn't expose X11 PRIMARY). macOS terminals use Cmd+C/V via
 * the native Edit menu roles instead.
 */
export function isTerminalClipboardCopyKey(event: KeyboardEvent): boolean {
  return (
    !isMac() &&
    event.ctrlKey &&
    event.shiftKey &&
    !event.metaKey &&
    !event.altKey &&
    (event.key === "C" || event.key === "c" || event.code === "KeyC")
  );
}

export function isTerminalClipboardPasteKey(event: KeyboardEvent): boolean {
  if (isMac()) return false;
  if (
    event.ctrlKey &&
    event.shiftKey &&
    !event.metaKey &&
    !event.altKey &&
    (event.key === "V" || event.key === "v" || event.code === "KeyV")
  ) {
    return true;
  }
  return (
    event.shiftKey &&
    !event.ctrlKey &&
    !event.metaKey &&
    !event.altKey &&
    (event.key === "Insert" || event.code === "Insert")
  );
}

/** Any key the terminal owns outright while focused — checked by the window
 *  capture handler before global shortcut resolution. */
export function isTerminalReservedKey(event: KeyboardEvent): boolean {
  return (
    isTuiReservedKey(event) ||
    isTerminalClipboardCopyKey(event) ||
    isTerminalClipboardPasteKey(event)
  );
}
