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

// ── Search utilities ──────────────────────────────────────────────────────
// Reverse-lookup map: display symbols/text → canonical modifier IDs.
// The inverse of MODIFIER_GLYPH_MAP / MODIFIER_TEXT_MAP, used by chord-prefix
// search to normalize user queries into the canonical token space.

export const MODIFIER_SEARCH_MAP: Record<string, string> = {
  cmd: "cmd",
  command: "cmd",
  meta: "cmd",
  ctrl: "ctrl",
  control: "ctrl",
  alt: "alt",
  option: "alt",
  shift: "shift",
  "⌘": "cmd",
  "⌃": "ctrl",
  "⌥": "alt",
  "⇧": "shift",
};

export const VALID_KEY_PATTERN = /^[a-z0-9`~!@#$%^&*()_\-=[\]{}\\|;:'",.<>/?]$/i;

export function isChordPrefix(query: string): boolean {
  const trimmed = query.toLowerCase().trim();
  if (!trimmed) return false;

  const hasModifierSymbol = /[⌘⌥⌃⇧]/.test(trimmed);
  const hasModifierText = /^(cmd|command|meta|ctrl|control|alt|option|shift)[+\s]/i.test(trimmed);

  if (!hasModifierSymbol && !hasModifierText) return false;

  let normalized = trimmed.replace(/\s*\+\s*/g, "+").replace(/\s+/g, "+");

  for (const [symbol, text] of Object.entries(MODIFIER_SEARCH_MAP)) {
    if (symbol !== text) {
      normalized = normalized.replace(new RegExp(symbol, "g"), text);
    }
  }

  const modifierMatch = Object.values(MODIFIER_SEARCH_MAP).find((m) => normalized.startsWith(m));
  if (!modifierMatch) return false;

  if (normalized.length <= modifierMatch.length) return false;

  const parts = normalized.split("+").filter(Boolean);
  if (parts.length >= 2) {
    return parts.every((p) => {
      if (Object.values(MODIFIER_SEARCH_MAP).includes(p)) return true;
      return p.length > 0 && VALID_KEY_PATTERN.test(p);
    });
  }

  const remaining = normalized.slice(modifierMatch.length);
  return remaining.length > 0 && VALID_KEY_PATTERN.test(remaining);
}

export function normalizeQuery(query: string): string {
  let normalized = query.toLowerCase().trim();
  normalized = normalized.replace(/\s*\+\s*/g, "+").replace(/\s+/g, "+");

  // Replace unicode modifier symbols globally (safe — these glyphs don't appear
  // in plain-English text, so there are no false positives).
  for (const [symbol, text] of Object.entries(MODIFIER_SEARCH_MAP)) {
    if (symbol !== text && /[⌘⌥⌃⇧]/.test(symbol)) {
      normalized = normalized.replace(new RegExp(symbol, "g"), text);
    }
  }

  // Map each +-separated token through the search map individually so modifier
  // aliases are only replaced when they appear as whole tokens, not as substrings
  // of unrelated words ("metadata" stays "metadata", not "cmddata").
  return normalized
    .split("+")
    .map((token) => MODIFIER_SEARCH_MAP[token] ?? token)
    .join("+");
}
