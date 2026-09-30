import { useEffect, useRef } from "react";
import type { PluginHotkey, UseHotkeysOptions } from "@shared/types/plugin-sdk-react";
import { usePluginKitViewHost, type PluginKitViewHost } from "@/components/PluginKit/kitViewHost";
import { isMac } from "@/lib/platform";
import { peekKit, withKit } from "./kit";

/** A combo in the app's notation, parsed. `primary` is Cmd on macOS, Ctrl elsewhere. */
export interface ParsedHotkey {
  primary: boolean;
  ctrl: boolean;
  shift: boolean;
  alt: boolean;
  key: string;
}

const KEY_ALIASES: Record<string, string> = {
  space: " ",
  spacebar: " ",
  esc: "escape",
  del: "delete",
  return: "enter",
  up: "arrowup",
  down: "arrowdown",
  left: "arrowleft",
  right: "arrowright",
  plus: "+",
};

function normalizeKey(key: string): string {
  const lower = key.toLowerCase();
  return KEY_ALIASES[lower] ?? lower;
}

/**
 * `"Cmd+Shift+Z"` → its parts; null for anything that is not one combo: an
 * empty string, a two-step chord (`"Cmd+K T"`), or modifiers with no key.
 */
export function parseHotkey(combo: unknown): ParsedHotkey | null {
  if (typeof combo !== "string") return null;
  const trimmed = combo.trim();
  if (trimmed === "" || /\s/.test(trimmed)) return null;
  // A trailing "+" is the plus key itself ("Cmd++").
  const parts = trimmed.endsWith("++")
    ? [...trimmed.slice(0, -2).split("+"), "+"]
    : trimmed.split("+");
  const key = parts.pop();
  if (key === undefined || key === "") return null;
  const parsed: ParsedHotkey = {
    primary: false,
    ctrl: false,
    shift: false,
    alt: false,
    key: normalizeKey(key),
  };
  for (const part of parts) {
    switch (part.toLowerCase()) {
      case "cmd":
      case "meta":
      case "mod":
        parsed.primary = true;
        break;
      case "ctrl":
      case "control":
        parsed.ctrl = true;
        break;
      case "shift":
        parsed.shift = true;
        break;
      case "alt":
      case "option":
        parsed.alt = true;
        break;
      default:
        return null;
    }
  }
  if (["meta", "control", "shift", "alt"].includes(parsed.key)) return null;
  return parsed;
}

/** Whether `event` is exactly `hotkey`: the same key and no modifier more or less. */
export function matchesHotkey(
  event: Pick<KeyboardEvent, "key" | "code" | "metaKey" | "ctrlKey" | "shiftKey" | "altKey">,
  hotkey: ParsedHotkey,
  mac: boolean
): boolean {
  // Elsewhere Cmd *is* Ctrl, so "Ctrl+X" and "Cmd+X" are the same key there.
  const wantMeta = mac && hotkey.primary;
  const wantCtrl = mac ? hotkey.ctrl : hotkey.primary || hotkey.ctrl;
  if (event.metaKey !== wantMeta || event.ctrlKey !== wantCtrl) return false;
  if (event.altKey !== hotkey.alt) return false;
  const key = normalizeKey(event.key);
  // Shift is part of a punctuation key's character ("?" is Shift+/), so a
  // combo naming that character does not have to name Shift as well.
  const shiftInKey = hotkey.key.length === 1 && !/[a-z0-9 ]/.test(hotkey.key);
  if (event.shiftKey !== hotkey.shift && !(shiftInKey && event.shiftKey && !hotkey.shift)) {
    return false;
  }
  if (key === hotkey.key) return true;
  // Option on macOS turns letters into other characters (Option+P is "π"):
  // fall back to the physical key for letters and digits.
  if (/^[a-z]$/.test(hotkey.key)) return event.code === `Key${hotkey.key.toUpperCase()}`;
  if (/^[0-9]$/.test(hotkey.key)) return event.code === `Digit${hotkey.key}`;
  // Shift and Option change what a punctuation key types ("Shift+;" is ":"),
  // so a combo naming the unshifted character also matches its physical key.
  const code = PUNCTUATION_CODES[hotkey.key];
  return code !== undefined && event.code === code;
}

/** The physical key each unshifted punctuation character sits on, as the host matcher reads it. */
const PUNCTUATION_CODES: Record<string, string> = {
  "/": "Slash",
  "\\": "Backslash",
  ",": "Comma",
  ".": "Period",
  ";": "Semicolon",
  "'": "Quote",
  "[": "BracketLeft",
  "]": "BracketRight",
  "`": "Backquote",
  "-": "Minus",
  "=": "Equal",
};

const TEXT_INPUT_TYPES = new Set([
  "text",
  "search",
  "email",
  "url",
  "password",
  "number",
  "tel",
  "date",
  "time",
  "datetime-local",
  "month",
  "week",
]);

/** Focus is somewhere keys are typing, not commands. */
export function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false;
  if (target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement) return true;
  if (target instanceof HTMLInputElement) return TEXT_INPUT_TYPES.has(target.type);
  if (target instanceof HTMLElement && target.isContentEditable) return true;
  return target.closest('[role="textbox"],[role="searchbox"],[role="combobox"],.xterm') !== null;
}

/**
 * The key belongs here: focus is inside `scope` when one is given; otherwise
 * inside the view, or in an overlay the view opened. Outside a plugin view,
 * with no scope, anywhere in the document.
 */
function inScope(
  event: KeyboardEvent,
  scope: UseHotkeysOptions["scope"],
  host: PluginKitViewHost | null
): boolean {
  const target = event.target instanceof Node ? event.target : null;
  if (scope) return !!(target && scope.current?.contains(target));
  if (!host) return true;
  if (host.keyEvents?.has(event)) return true;
  return !!(target && host.root.current?.contains(target));
}

const warnedConflicts = new Set<string>();

/**
 * Keyboard shortcuts for one view or one element of it, in the app's chord
 * notation. A key the app itself is bound to always goes to the app: the
 * host's shortcuts run first, and a combo matching one of them is skipped
 * here too, with a warning in development. Keys typed into a text field are
 * left alone unless a binding sets `allowInInput`.
 */
export function useHotkeys(hotkeys: readonly PluginHotkey[], rawOptions?: UseHotkeysOptions): void {
  const options: UseHotkeysOptions =
    typeof rawOptions === "object" && rawOptions !== null ? rawOptions : {};
  const host = usePluginKitViewHost();
  const bindings = useRef(hotkeys);
  const scope = options.scope;
  const enabled = options.enabled !== false;
  useEffect(() => {
    bindings.current = hotkeys;
  });

  const combos = Array.isArray(hotkeys)
    ? hotkeys.map((hotkey) => (typeof hotkey?.combo === "string" ? hotkey.combo : "")).join("\n")
    : "";

  useEffect(() => {
    if (!import.meta.env.DEV || combos === "") return;
    withKit((kit) => {
      for (const combo of combos.split("\n")) {
        if (combo === "" || warnedConflicts.has(combo)) continue;
        if (parseHotkey(combo) === null) {
          warnedConflicts.add(combo);
          console.warn(`[plugin-ui] useHotkeys: "${combo}" is not a single combo; it is ignored.`);
          continue;
        }
        const owner = kit.hotkeyHostBinding(combo);
        if (owner) {
          warnedConflicts.add(combo);
          console.warn(
            `[plugin-ui] useHotkeys: "${combo}" is bound to Daintree's "${owner}". The app keeps it: this binding is skipped wherever that shortcut is live, whatever its conditions.`
          );
        }
      }
    });
  }, [combos]);

  useEffect(() => {
    if (!enabled || typeof document === "undefined") return;
    const listener = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.isComposing) return;
      if (!inScope(event, scope, host)) return;
      const list = bindings.current;
      if (!Array.isArray(list)) return;
      const mac = isMac();
      const typing = isTypingTarget(event.target);
      for (const hotkey of list) {
        if (typeof hotkey !== "object" || hotkey === null || hotkey.disabled === true) continue;
        if (typeof hotkey.handler !== "function") continue;
        if (typing && hotkey.allowInInput !== true) continue;
        const parsed = parseHotkey(hotkey.combo);
        if (!parsed || !matchesHotkey(event, parsed, mac)) continue;
        // Until the kit is in, the host's bindings cannot be read, so the key
        // is left to the app rather than risk taking one of them.
        const kit = peekKit();
        if (!kit || kit.hotkeyHostOwnsEvent(event)) return;
        // A throw propagates like any listener's: the key is not claimed.
        const result = hotkey.handler(event);
        if (result !== false) event.preventDefault();
        return;
      }
    };
    // Bubble phase on the document: the host's shortcuts listen in the
    // capture phase and stop what they consume, and React's own handlers
    // (a list's arrow keys) run first and can prevent the default.
    document.addEventListener("keydown", listener);
    return () => document.removeEventListener("keydown", listener);
  }, [enabled, scope, host]);
}
