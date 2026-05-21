import type { BuiltInActionId, ActionId } from "@shared/types/actions";
import { isMac } from "@/lib/platform";

export type KeyScope = "global" | "terminal" | "modal" | "worktreeList" | "portal" | "worktreeGrid";

export interface KeybindingConfig {
  actionId: BuiltInActionId;
  combo: string; // e.g., "Cmd+T", "Ctrl+Shift+P", "Escape", "Cmd+K Cmd+S" (chords)
  scope: KeyScope;
  priority: number; // Higher priority wins in conflicts (default 0)
  description?: string;
  category?: string; // Category for organization in UI (e.g., "Terminal", "Panels")
}

// Wide variant for internal storage, registerBinding, and return types — actionId
// accepts plugin-defined IDs via the ActionId open union.
export type RegisteredKeybindingConfig = Omit<KeybindingConfig, "actionId"> & {
  actionId: ActionId;
};

// "conflict": same combo as an existing binding in an overlapping scope.
// "shadowed": chord-prefix collision — registering this combo would make either
// the new binding or the existing chord unreachable (e.g. "Cmd+K" vs "Cmd+K Cmd+S").
export interface KeybindingConflict extends RegisteredKeybindingConfig {
  kind: "conflict" | "shadowed";
}

export interface KeybindingResolutionResult {
  match: RegisteredKeybindingConfig | undefined;
  chordPrefix: boolean;
  shouldConsume: boolean;
}

// Window for completing a chord (e.g. the gap between "Cmd+K" and "Cmd+S").
// Shared between the runtime matcher and the recorder UI so they stay in sync.
export const CHORD_TIMEOUT_MS = 1000;

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
  const mac = isMac();

  // Prefer physical key code for punctuation (handles Option/Alt modifiers)
  if (event.code && CODE_TO_KEY[event.code]) {
    return CODE_TO_KEY[event.code]!;
  }

  // Handle letter keys when Alt is pressed on macOS only (Alt+P produces π instead of P)
  // On Windows/Linux, AltGr (Right Alt) sets both altKey and ctrlKey, and we want to preserve
  // the produced character for non-US layouts
  // event.code for letters is like "KeyA", "KeyB", ..., "KeyP", etc.
  if (
    mac &&
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
    mac &&
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

function singleComboFieldsEqual(a: string, b: string, mac: boolean): boolean {
  const pa = parseCombo(a);
  const pb = parseCombo(b);
  // On non-Mac, Cmd and Ctrl bindings both fire on the physical Ctrl key, so
  // "Cmd+Shift+E" and "Ctrl+Shift+E" must compare equal for conflict detection
  // and registration guards. On Mac the keys are physically distinct — keep
  // them separate. (#7941)
  const aCmd = mac ? pa.cmd : pa.cmd || pa.ctrl;
  const bCmd = mac ? pb.cmd : pb.cmd || pb.ctrl;
  const aCtrl = mac ? pa.ctrl : false;
  const bCtrl = mac ? pb.ctrl : false;
  return (
    aCmd === bCmd &&
    aCtrl === bCtrl &&
    pa.shift === pb.shift &&
    pa.alt === pb.alt &&
    pa.key.toLowerCase() === pb.key.toLowerCase()
  );
}

/**
 * Compare two combo strings field-by-field with platform-aware Cmd/Ctrl
 * folding. Handles both single combos ("Cmd+Shift+E") and chord sequences
 * ("Cmd+K Cmd+W") by splitting on whitespace and comparing each segment.
 *
 * On non-Mac platforms, "Cmd+X" and "Ctrl+X" are considered equal because
 * they map to the same physical key. On Mac they remain distinct.
 */
export function combosFieldsEqual(a: string, b: string, mac = isMac()): boolean {
  const segmentsA = a.trim().split(/\s+/).filter(Boolean);
  const segmentsB = b.trim().split(/\s+/).filter(Boolean);
  if (segmentsA.length === 0 || segmentsB.length === 0) return false;
  if (segmentsA.length !== segmentsB.length) return false;
  for (let i = 0; i < segmentsA.length; i++) {
    if (!singleComboFieldsEqual(segmentsA[i]!, segmentsB[i]!, mac)) return false;
  }
  return true;
}
