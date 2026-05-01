/**
 * Pure chord-parsing utility for keyboard shortcuts. Returns display tokens
 * grouped by chord step so React components can render per-key pills without
 * touching `navigator` directly.
 *
 * Steps (two-step chords) are separated by whitespace: `"Cmd+K T"` →
 * `[["⌘","K"],["T"]]`. Keys within a step are separated by `+`.
 *
 * `isMac` is injected as a parameter so the parser can be tested without
 * mutating the cached `navigator.platform` lookup in `src/lib/platform.ts`.
 */

const MAC_GLYPHS: Record<string, string> = {
  cmd: "⌘",
  command: "⌘",
  meta: "⌘",
  ctrl: "⌃",
  control: "⌃",
  alt: "⌥",
  option: "⌥",
  shift: "⇧",
  return: "⏎",
  enter: "⏎",
  escape: "⎋",
  esc: "⎋",
  tab: "⇥",
  backspace: "⌫",
  delete: "⌦",
  del: "⌦",
};

const WIN_LABELS: Record<string, string> = {
  cmd: "Ctrl",
  command: "Ctrl",
  meta: "Ctrl",
  ctrl: "Ctrl",
  control: "Ctrl",
  alt: "Alt",
  option: "Alt",
  shift: "Shift",
  return: "Enter",
  enter: "Enter",
  escape: "Esc",
  esc: "Esc",
  tab: "Tab",
  backspace: "Backspace",
  delete: "Delete",
  del: "Delete",
};

// Arrow keys render as glyphs on every platform — they're unambiguous and
// take less horizontal space than the spelled-out names.
const ARROW_GLYPHS: Record<string, string> = {
  up: "↑",
  arrowup: "↑",
  down: "↓",
  arrowdown: "↓",
  left: "←",
  arrowleft: "←",
  right: "→",
  arrowright: "→",
};

export const MODIFIER_GLYPH_MAP = MAC_GLYPHS;
export const MODIFIER_TEXT_MAP = WIN_LABELS;

function mapToken(rawToken: string, isMac: boolean): string {
  const lower = rawToken.toLowerCase();
  const arrow = ARROW_GLYPHS[lower];
  if (arrow) return arrow;
  const table = isMac ? MAC_GLYPHS : WIN_LABELS;
  const mapped = table[lower];
  if (mapped) return mapped;
  // Single-char keys are uppercased ("p" → "P"). Multi-char unknowns keep
  // their original casing so labels like "PageUp" or "NumpadEnter" don't
  // get mangled to "Pageup".
  if (rawToken.length === 1) return rawToken.toUpperCase();
  return rawToken;
}

function splitStepKeys(step: string): string[] {
  const trimmed = step.trim();
  if (!trimmed) return [];

  // A bare `+` step or a `++` suffix means a literal `+` key (e.g. `Ctrl++`
  // for zoom). A single trailing `+` (e.g. `Ctrl+`) is malformed and
  // ignored — only `++` promotes the trailing plus to a literal.
  if (trimmed === "+") return ["+"];

  const literalPlus = trimmed.endsWith("++");
  const body = literalPlus ? trimmed.slice(0, -1) : trimmed;
  const parts = body
    .split("+")
    .map((part) => part.trim())
    .filter((part) => part.length > 0);

  if (literalPlus) parts.push("+");
  return parts;
}

/**
 * Parse a shortcut string into display tokens grouped by chord step.
 *
 * @example
 * parseChord("Cmd+Shift+P", true)   // [["⌘","⇧","P"]]
 * parseChord("Cmd+K T", true)        // [["⌘","K"],["T"]]
 * parseChord("Ctrl++", false)        // [["Ctrl","+"]]
 * parseChord("", true)               // []
 */
export function parseChord(shortcut: string, isMac: boolean): string[][] {
  if (!shortcut || !shortcut.trim()) return [];

  // Collapse whitespace around `+` first so " Cmd + Shift + P " stays a single
  // chord step. Remaining whitespace is the chord-step separator.
  const normalized = shortcut.trim().replace(/\s*\+\s*/g, "+");
  const steps = normalized
    .split(/\s+/)
    .map((step) => splitStepKeys(step))
    .filter((tokens) => tokens.length > 0);

  return steps.map((tokens) => tokens.map((token) => mapToken(token, isMac)));
}
