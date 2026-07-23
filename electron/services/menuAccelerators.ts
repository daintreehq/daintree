import { buildDefaultKeybindings } from "../../shared/config/defaultKeybindings.js";
import { getValidatedOverrides } from "./keybindingOverridesStore.js";

/**
 * Native menu accelerators derived from the same source the renderer resolves
 * keystrokes against: shared defaults + persisted user overrides. This is what
 * keeps the menu truthful — a rebind updates the menu on the next rebuild
 * (electron/ipc/handlers/keybinding.ts triggers one after every mutation).
 *
 * Renderer-owned accelerators stay natively registered on every platform, and
 * are additionally collected per menu build so before-input-event can suppress
 * their native dispatch per keystroke (setIgnoreMenuShortcuts in
 * createWindow.ts / ProjectViewHandlers.ts) — the renderer's KeybindingService
 * owns keyboard execution (scopes, priorities, when-clauses, xterm exceptions)
 * whenever an app renderer has focus. When focus is somewhere the app renderer
 * never sees the key — a browser-panel/dev-preview guest webview, DevTools —
 * no suppression runs and the registered accelerator executes natively, so
 * shortcuts keep working there instead of going dead.
 */

const KEY_TO_ACCELERATOR: Record<string, string> = {
  ArrowUp: "Up",
  ArrowDown: "Down",
  ArrowLeft: "Left",
  ArrowRight: "Right",
  Escape: "Escape",
  Enter: "Enter",
  Space: "Space",
  Backspace: "Backspace",
  Delete: "Delete",
  Tab: "Tab",
  Home: "Home",
  End: "End",
  PageUp: "PageUp",
  PageDown: "PageDown",
};

interface ParsedAccelerator {
  /** Cmd on macOS, Ctrl on Windows/Linux (CommandOrControl). */
  primary: boolean;
  /** Explicit Control (distinct from primary only on macOS). */
  ctrl: boolean;
  shift: boolean;
  alt: boolean;
  key: string;
}

/**
 * Convert a Daintree combo string ("Cmd+Shift+P") to an Electron accelerator
 * ("CommandOrControl+Shift+P"). Chords ("Cmd+K Cmd+S") are unrepresentable as
 * native accelerators — the item simply carries none.
 */
export function comboToAccelerator(combo: string): string | undefined {
  const trimmed = combo.trim();
  if (!trimmed || /\s/.test(trimmed)) return undefined;

  const parts = trimmed.split("+");
  const rawKey = parts.pop() ?? "";
  if (!rawKey) return undefined;

  const accelerator: string[] = [];
  for (const part of parts) {
    switch (part.trim().toLowerCase()) {
      case "cmd":
      case "meta":
        accelerator.push("CommandOrControl");
        break;
      case "ctrl":
        accelerator.push("Control");
        break;
      case "shift":
        accelerator.push("Shift");
        break;
      case "alt":
      case "option":
        accelerator.push("Alt");
        break;
      default:
        return undefined;
    }
  }

  const key = KEY_TO_ACCELERATOR[rawKey] ?? (rawKey.length === 1 ? rawKey.toUpperCase() : rawKey);
  accelerator.push(key);
  return accelerator.join("+");
}

function getDefaultKeybindingsForPlatform() {
  return buildDefaultKeybindings(process.platform === "win32");
}

/**
 * Effective single-stroke combo for an action: user override first (an empty
 * override array means deliberately unbound — no fallback to the default),
 * else the first global-scope default. Mirrors the renderer's
 * getEffectiveCombo semantics.
 */
export function getEffectiveMenuCombo(actionId: string): string | undefined {
  const overrides = getValidatedOverrides();
  const override = overrides[actionId];
  if (override) {
    return override.length > 0 ? override[0] : undefined;
  }
  const binding = getDefaultKeybindingsForPlatform().find(
    (b) => b.actionId === actionId && b.scope === "global" && b.combo
  );
  return binding?.combo;
}

export function getMenuAccelerator(actionId: string): string | undefined {
  const combo = getEffectiveMenuCombo(actionId);
  return combo ? comboToAccelerator(combo) : undefined;
}

/**
 * Whether the keybinding system owns this action's shortcut: a user override
 * exists (including an explicit empty "unbound" one) or the shipped defaults
 * carry a row for it. Owned actions must never fall back to registry-declared
 * shortcuts — a cleared or chord-bound action would silently resurrect the
 * old native accelerator.
 */
export function isKeybindingOwnedAction(actionId: string): boolean {
  if (actionId in getValidatedOverrides()) return true;
  return getDefaultKeybindingsForPlatform().some((b) => b.actionId === actionId);
}

let rendererOwnedAccelerators: ParsedAccelerator[] = [];

function parseAccelerator(accelerator: string): ParsedAccelerator | null {
  const parts = accelerator.split("+");
  const key = parts.pop();
  if (!key) return null;
  const parsed: ParsedAccelerator = {
    primary: false,
    ctrl: false,
    shift: false,
    alt: false,
    key,
  };
  for (const part of parts) {
    switch (part) {
      case "CommandOrControl":
        parsed.primary = true;
        break;
      case "Control":
        parsed.ctrl = true;
        break;
      case "Shift":
        parsed.shift = true;
        break;
      case "Alt":
        parsed.alt = true;
        break;
      default:
        return null;
    }
  }
  return parsed;
}

/** Called at the top of every createApplicationMenu build. */
export function resetRendererOwnedAccelerators(): void {
  rendererOwnedAccelerators = [];
}

/**
 * Resolve the accelerator for a renderer-owned menu item and record it in the
 * suppression set consulted by before-input-event.
 */
export function rendererMenuAccelerator(actionId: string): string | undefined {
  const accelerator = getMenuAccelerator(actionId);
  trackRendererOwnedAccelerator(accelerator);
  return accelerator;
}

export function trackRendererOwnedAccelerator(accelerator: string | undefined): void {
  if (!accelerator) return;
  const parsed = parseAccelerator(accelerator);
  if (parsed) rendererOwnedAccelerators.push(parsed);
}

/**
 * Does this before-input-event input match a renderer-owned menu accelerator?
 * Used to setIgnoreMenuShortcuts for the current event on macOS, where native
 * key equivalents would otherwise fire before the renderer ever sees the key
 * (bypassing scopes, priorities, and rebind-aware resolution).
 */
export function isRendererOwnedShortcut(input: Electron.Input): boolean {
  if (input.type !== "keyDown" || rendererOwnedAccelerators.length === 0) return false;
  const mac = process.platform === "darwin";
  const inputKey = input.key.length === 1 ? input.key.toUpperCase() : input.key;

  for (const acc of rendererOwnedAccelerators) {
    const primaryDown = mac ? input.meta : input.control;
    if (acc.primary !== primaryDown) continue;
    // Explicit Control is only distinct from primary on macOS; on other
    // platforms it folded into `primary` at parse time via CommandOrControl.
    if (mac && acc.ctrl !== input.control) continue;
    if (!mac && !acc.primary && acc.ctrl && !input.control) continue;
    if (acc.shift !== input.shift) continue;
    if (acc.alt !== input.alt) continue;
    if (mac && !acc.primary && input.meta) continue;

    const accKey = acc.key.length === 1 ? acc.key.toUpperCase() : acc.key;
    if (inputKey === accKey) return true;
    // Physical digit-row parity with the renderer matcher: on layouts that
    // shift their number row, input.key for Digit1 is "&" — match by code.
    if (/^[0-9]$/.test(accKey) && input.code === `Digit${accKey}`) return true;
    // Option-modified letters on macOS produce transformed characters
    // (Option+T → "†"), mirroring the renderer's code-based normalization for
    // mac Alt combos — match the physical letter key instead.
    if (mac && input.alt && /^[A-Z]$/.test(accKey) && input.code === `Key${accKey}`) return true;
    // Arrow keys arrive as "ArrowUp" etc. on Input; accelerators store "Up".
    if (input.key === `Arrow${accKey}`) return true;
  }
  return false;
}
