export type KeyScope = "global" | "terminal" | "modal" | "worktreeList" | "sidecar";

export interface KeybindingConfig {
  actionId: string;
  combo: string; // e.g., "Cmd+T", "Ctrl+Shift+P", "Escape", "Cmd+K Cmd+S" (chords)
  scope: KeyScope;
  priority: number; // Higher priority wins in conflicts (default 0)
  description?: string;
  category?: string; // Category for organization in UI (e.g., "Terminal", "Panels")
}

export interface KeybindingResolutionResult {
  match: KeybindingConfig | undefined;
  chordPrefix: boolean;
  shouldConsume: boolean;
}

// Map physical key codes to standard characters
// Fixes issues where Option/Alt changes the character (e.g., Option+/ becomes ÷ on Mac)
export const CODE_TO_KEY: Record<string, string> = {
  Slash: "/",
  Backslash: "\\",
  Comma: ",",
  Period: ".",
  Semicolon: ";",
  Quote: "'",
  BracketLeft: "[",
  BracketRight: "]",
  Backquote: "`",
  Minus: "-",
  Equal: "=",
  IntlBackslash: "\\",
};

export function normalizeKey(key: string): string {
  const keyMap: Record<string, string> = {
    " ": "Space",
    arrowup: "ArrowUp",
    arrowdown: "ArrowDown",
    arrowleft: "ArrowLeft",
    arrowright: "ArrowRight",
    escape: "Escape",
    enter: "Enter",
    return: "Enter",
    tab: "Tab",
    home: "Home",
    end: "End",
    pageup: "PageUp",
    pagedown: "PageDown",
    backspace: "Backspace",
    delete: "Delete",
  };
  return keyMap[key.toLowerCase()] || key;
}

/**
 * Normalize a keyboard event to get the correct key for keybinding matching.
 * This handles Option/Alt modifiers on macOS that change characters (e.g., Option+/ becomes ÷, Option+P becomes π).
 * Use this function in both the keybinding matcher and the shortcut recorder to ensure consistency.
 */
export function normalizeKeyForBinding(event: KeyboardEvent): string {
  // Detect macOS
  const isMac =
    typeof navigator !== "undefined" &&
    navigator.platform &&
    navigator.platform.toUpperCase().indexOf("MAC") >= 0;

  // Prefer physical key code for punctuation (handles Option/Alt modifiers)
  if (event.code && CODE_TO_KEY[event.code]) {
    return CODE_TO_KEY[event.code];
  }

  // Handle letter keys when Alt is pressed on macOS only (Alt+P produces π instead of P)
  // On Windows/Linux, AltGr (Right Alt) sets both altKey and ctrlKey, and we want to preserve
  // the produced character for non-US layouts
  // event.code for letters is like "KeyA", "KeyB", ..., "KeyP", etc.
  if (
    isMac &&
    event.altKey &&
    event.code &&
    event.code.startsWith("Key") &&
    event.code.length === 4
  ) {
    return event.code.charAt(3).toUpperCase();
  }

  // Handle digit keys when Alt is pressed on macOS (Alt+1 produces ¡ instead of 1)
  // event.code for digits is like "Digit0", "Digit1", ..., "Digit9"
  if (
    isMac &&
    event.altKey &&
    event.code &&
    event.code.startsWith("Digit") &&
    event.code.length === 6
  ) {
    return event.code.charAt(5);
  }

  // Fallback to character-based normalization
  return normalizeKey(event.key);
}

export function parseCombo(combo: string): {
  cmd: boolean;
  ctrl: boolean;
  shift: boolean;
  alt: boolean;
  key: string;
} {
  const parts = combo.split("+").map((p) => p.trim());
  const key = normalizeKey(parts.pop() || "");

  return {
    cmd: parts.some((p) => p.toLowerCase() === "cmd" || p.toLowerCase() === "meta"),
    ctrl: parts.some((p) => p.toLowerCase() === "ctrl"),
    shift: parts.some((p) => p.toLowerCase() === "shift"),
    alt: parts.some((p) => p.toLowerCase() === "alt" || p.toLowerCase() === "option"),
    key,
  };
}
