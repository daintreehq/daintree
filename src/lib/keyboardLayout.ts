import { useSyncExternalStore } from "react";
import { CODE_TO_KEY } from "@/services/keybindingUtils";

/**
 * What the active keyboard layout prints on the keys that bindings match
 * physically: the canonical combo character (`"/"`, `"["`) → the character the
 * same physical key types on this layout (`"!"`, `"^"` on AZERTY). Only keys
 * whose label differs are present, so an empty map draws every label as US.
 */
export type KeyLabels = ReadonlyMap<string, string>;

/** The US labels: no layout read, or a layout that reads as US. */
export const US_KEY_LABELS: KeyLabels = new Map();

interface LayoutMapLike {
  get(code: string): string | undefined;
  forEach(callback: (value: string, code: string) => void): void;
}

interface KeyboardLike {
  getLayoutMap?: () => Promise<LayoutMapLike>;
}

function getKeyboard(): KeyboardLike | undefined {
  if (typeof navigator === "undefined") return undefined;
  return (navigator as Navigator & { keyboard?: KeyboardLike }).keyboard;
}

// One printable character: no control, separator or lone combining mark.
const LABEL_CHAR = /^[^\p{C}\p{Z}\p{M}]$/u;

/** The layout's character as a key cap can print it, or undefined. */
function readableLabel(produced: string | undefined): string | undefined {
  if (produced === undefined) return undefined;
  const composed = produced.normalize("NFC");
  return LABEL_CHAR.test(composed) ? composed : undefined;
}

// The codes behind each canonical character, in CODE_TO_KEY order, so
// Backslash comes before IntlBackslash for "\".
const CODES_BY_CHAR = new Map<string, string[]>();
for (const [code, char] of Object.entries(CODE_TO_KEY)) {
  const codes = CODES_BY_CHAR.get(char);
  if (codes) codes.push(code);
  else CODES_BY_CHAR.set(char, [code]);
}

/** The labels a layout map gives the physically matched keys. */
export function deriveKeyLabels(layout: LayoutMapLike): KeyLabels {
  const labels = new Map<string, string>();
  for (const [char, codes] of CODES_BY_CHAR) {
    const produced = codes.map((code) => readableLabel(layout.get(code)));
    // A binding on "\" fires from Backslash and IntlBackslash alike: if either
    // key types "\" on this layout, the US label already names a key that fires.
    if (produced.includes(char)) continue;
    const label = produced.find((value) => value !== undefined);
    if (label !== undefined) labels.set(char, label);
  }
  return labels.size === 0 ? US_KEY_LABELS : labels;
}

function sameLabels(a: KeyLabels, b: KeyLabels): boolean {
  if (a.size !== b.size) return false;
  for (const [char, label] of a) {
    if (b.get(char) !== label) return false;
  }
  return true;
}

let keyLabels: KeyLabels = US_KEY_LABELS;
// Every code the last read reported, for spotting a layout switch from typing.
let layoutChars: ReadonlyMap<string, string> | null = null;
// Keystrokes that disagreed with a fresh read, and when. Typing on a layout the
// read doesn't report (a non-Latin input source, which Chromium answers with
// the ASCII-capable layout behind it) then asks the OS about each key once a
// minute rather than on every keystroke.
const unresolvedMismatches = new Map<string, number>();
const MISMATCH_RECHECK_MS = 60_000;
const listeners = new Set<() => void>();
let readGeneration = 0;
let stopWatching: (() => void) | null = null;

function publish(next: KeyLabels): void {
  if (sameLabels(keyLabels, next)) return;
  keyLabels = next;
  for (const listener of Array.from(listeners)) listener();
}

function applyLayout(layout: LayoutMapLike | null): void {
  if (!layout) {
    layoutChars = null;
    unresolvedMismatches.clear();
    publish(US_KEY_LABELS);
    return;
  }
  const chars = new Map<string, string>();
  layout.forEach((value, code) => chars.set(code, value));
  if (!layoutChars || !sameLabels(layoutChars, chars)) unresolvedMismatches.clear();
  layoutChars = chars;
  publish(deriveKeyLabels(layout));
}

async function readLayout(): Promise<void> {
  const keyboard = getKeyboard();
  if (typeof keyboard?.getLayoutMap !== "function") return;
  const generation = ++readGeneration;
  let layout: LayoutMapLike | null;
  try {
    layout = await keyboard.getLayoutMap();
  } catch {
    layout = null;
  }
  // A newer read, or a stop, owns the result.
  if (generation !== readGeneration) return;
  applyLayout(layout);
}

function onKeyDown(event: KeyboardEvent): void {
  if (!layoutChars) return;
  if (event.repeat || event.isComposing) return;
  if (event.ctrlKey || event.metaKey || event.altKey || event.shiftKey) return;
  if (event.getModifierState?.("AltGraph")) return;
  const key = event.key;
  if (typeof key !== "string" || [...key].length !== 1) return;
  const expected = layoutChars.get(event.code);
  if (expected === undefined || expected.toLowerCase() === key.toLowerCase()) return;
  const signature = `${event.code}\u0000${key}`;
  const now = Date.now();
  const askedAt = unresolvedMismatches.get(signature);
  if (askedAt !== undefined && now - askedAt < MISMATCH_RECHECK_MS) return;
  unresolvedMismatches.set(signature, now);
  void readLayout();
}

function onFocus(): void {
  void readLayout();
}

function onVisibilityChange(): void {
  if (document.visibilityState === "visible") void readLayout();
}

// Chromium has no layout-change event, so the layout is read again whenever
// it could have changed unseen: the window coming back, or a keystroke typing
// something other than what the last read says that key types.
function startWatching(): void {
  if (stopWatching || typeof getKeyboard()?.getLayoutMap !== "function") return;
  if (typeof window === "undefined" || typeof window.addEventListener !== "function") return;
  window.addEventListener("keydown", onKeyDown, true);
  window.addEventListener("focus", onFocus);
  document.addEventListener("visibilitychange", onVisibilityChange);
  stopWatching = () => {
    window.removeEventListener("keydown", onKeyDown, true);
    window.removeEventListener("focus", onFocus);
    document.removeEventListener("visibilitychange", onVisibilityChange);
  };
  void readLayout();
}

/** Calls `listener` when the labels change; the layout is watched while anyone listens. */
export function subscribeKeyLabels(listener: () => void): () => void {
  listeners.add(listener);
  startWatching();
  return () => {
    if (!listeners.delete(listener) || listeners.size > 0) return;
    stopWatching?.();
    stopWatching = null;
    readGeneration++;
  };
}

/** The labels as last read; {@link US_KEY_LABELS} until a read lands. */
export function getKeyLabels(): KeyLabels {
  return keyLabels;
}

const getServerKeyLabels = (): KeyLabels => US_KEY_LABELS;

/** The active layout's labels for physically matched keys, kept current. */
export function useKeyLabels(): KeyLabels {
  return useSyncExternalStore(subscribeKeyLabels, getKeyLabels, getServerKeyLabels);
}

/** Test-only: drop all state and listeners. */
export function resetKeyboardLayoutForTests(): void {
  stopWatching?.();
  stopWatching = null;
  listeners.clear();
  readGeneration++;
  keyLabels = US_KEY_LABELS;
  layoutChars = null;
  unresolvedMismatches.clear();
}
