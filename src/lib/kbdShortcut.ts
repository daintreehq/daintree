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

  // Collapse whitespace around a JOINING `+` so " Cmd + Shift + P " stays a
  // single chord step. Remaining whitespace is the chord-step separator.
  //
  // Only a `+` between two keys joins. A `+` standing alone as a step
  // ("Cmd+K +") or doubled as a literal key before a step break ("Cmd++ Cmd+P")
  // is a key, and the whitespace beside it is a step boundary — collapsing it
  // there dropped the literal step or merged two steps into one.
  const normalized = shortcut
    .trim()
    .replace(/\s+\+\s+(?=\S)/g, "+")
    .replace(/(?<=[^\s+])\+\s+(?=\S)/g, "+")
    .replace(/\s+\+(?=[^\s+])/g, "+");
  const steps = normalized
    .split(/\s+/)
    .map((step) => splitStepKeys(step))
    .filter((tokens) => tokens.length > 0);

  return steps.map((tokens) => tokens.map((token) => mapToken(token, isMac)));
}

// ── Search utilities ──────────────────────────────────────────────────────
// Reverse-lookup map: display symbols/text → canonical modifier IDs.
// The inverse of MAC_GLYPHS / WIN_LABELS, used by chord-prefix search to
// normalize user queries into the canonical token space.

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

// ── ARIA keyshortcuts conversion ──────────────────────────────────────────
// WAI-ARIA `aria-keyshortcuts` requires the canonical `Modifier+Modifier+Key`
// grammar (e.g. `Control+Shift+P`), distinct from our visible glyph form
// (`⌃⇧P`). Multiple alternatives and chord steps are both space-separated
// (the spec overloads the space delimiter — screen readers announce the full
// string verbatim, so a chord like `Cmd+K T` becomes `Meta+K T`).
//
// macOS `Cmd` maps to ARIA `Meta`; on Win/Linux the runtime swaps `Cmd` for
// the physical Ctrl key (see `KeybindingService.matchesEvent`), so the aria
// value emits `Control` to match what's actually pressed on that platform.

const ARIA_MAC_MODIFIERS: Record<string, string> = {
  cmd: "Meta",
  command: "Meta",
  meta: "Meta",
  ctrl: "Control",
  control: "Control",
  alt: "Alt",
  option: "Alt",
  shift: "Shift",
};

const ARIA_WIN_MODIFIERS: Record<string, string> = {
  cmd: "Control",
  command: "Control",
  meta: "Control",
  ctrl: "Control",
  control: "Control",
  alt: "Alt",
  option: "Alt",
  shift: "Shift",
};

const ARIA_KEY_NAMES: Record<string, string> = {
  return: "Enter",
  enter: "Enter",
  escape: "Escape",
  esc: "Escape",
  tab: "Tab",
  backspace: "Backspace",
  delete: "Delete",
  del: "Delete",
  up: "ArrowUp",
  arrowup: "ArrowUp",
  down: "ArrowDown",
  arrowdown: "ArrowDown",
  left: "ArrowLeft",
  arrowleft: "ArrowLeft",
  right: "ArrowRight",
  arrowright: "ArrowRight",
  space: "Space",
  pageup: "PageUp",
  pagedown: "PageDown",
  home: "Home",
  end: "End",
};

function mapAriaToken(rawToken: string, modifiers: Record<string, string>): string {
  const lower = rawToken.toLowerCase();
  const modifier = modifiers[lower];
  if (modifier) return modifier;
  const named = ARIA_KEY_NAMES[lower];
  if (named) return named;
  if (rawToken.length === 1) return rawToken.toUpperCase();
  return rawToken;
}

/**
 * Convert a canonical combo string into the WAI-ARIA `aria-keyshortcuts`
 * grammar. Returns `undefined` for empty/nullish input so the attribute can
 * be omitted entirely rather than rendered as an empty string.
 *
 * Multi-step chord sequences (e.g. `Cmd+K T`) also return `undefined`: ARIA
 * uses spaces to separate alternative shortcuts, not chord steps, so emitting
 * the joined form mislabels the binding for assistive tech.
 *
 * @example
 * comboToAriaKeyshortcuts("Cmd+Shift+P", true)  // "Meta+Shift+P"
 * comboToAriaKeyshortcuts("Ctrl++", false)      // "Control++"
 * comboToAriaKeyshortcuts("Cmd+K T", true)      // undefined (chord)
 * comboToAriaKeyshortcuts(undefined, true)      // undefined
 */
export function comboToAriaKeyshortcuts(
  combo: string | null | undefined,
  isMac: boolean
): string | undefined {
  if (!combo || !combo.trim()) return undefined;

  const modifiers = isMac ? ARIA_MAC_MODIFIERS : ARIA_WIN_MODIFIERS;
  const normalized = combo.trim().replace(/\s*\+\s*/g, "+");

  const steps = normalized
    .split(/\s+/)
    .map((step) => splitStepKeys(step))
    .filter((tokens) => tokens.length > 0)
    .map((tokens) => tokens.map((token) => mapAriaToken(token, modifiers)).join("+"));

  if (steps.length === 0) return undefined;
  if (steps.length > 1) return undefined;
  return steps[0];
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

// ── Spoken form ───────────────────────────────────────────────────────────
// The visible chips are glyphs, and screen readers read ⌘ ⌥ ⇧ ⌃ as "place of
// interest sign", "option key", "upwards white arrow" and "up arrowhead" —
// or skip them. This is the text a listener needs instead: key names in the
// platform's own words, "then" between chord steps.

const SPOKEN_MAC_NAMES: Record<string, string> = {
  cmd: "Command",
  command: "Command",
  meta: "Command",
  ctrl: "Control",
  control: "Control",
  alt: "Option",
  option: "Option",
  shift: "Shift",
  return: "Return",
  enter: "Return",
  escape: "Escape",
  esc: "Escape",
  backspace: "Delete",
  delete: "Forward Delete",
  del: "Forward Delete",
};

const SPOKEN_WIN_NAMES: Record<string, string> = {
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
  escape: "Escape",
  esc: "Escape",
  backspace: "Backspace",
  delete: "Delete",
  del: "Delete",
};

const SPOKEN_KEY_NAMES: Record<string, string> = {
  tab: "Tab",
  space: "Space",
  up: "Up Arrow",
  arrowup: "Up Arrow",
  down: "Down Arrow",
  arrowdown: "Down Arrow",
  left: "Left Arrow",
  arrowleft: "Left Arrow",
  right: "Right Arrow",
  arrowright: "Right Arrow",
  pageup: "Page Up",
  pagedown: "Page Down",
  contextmenu: "Menu",
  "/": "Slash",
  "\\": "Backslash",
  ".": "Period",
  ",": "Comma",
  "`": "Backtick",
  "=": "Equals",
  "-": "Minus",
  "+": "Plus",
  "[": "Left Bracket",
  "]": "Right Bracket",
  ";": "Semicolon",
  "'": "Quote",
};

function spokenToken(rawToken: string, isMac: boolean): string {
  const lower = rawToken.toLowerCase();
  const named = (isMac ? SPOKEN_MAC_NAMES : SPOKEN_WIN_NAMES)[lower] ?? SPOKEN_KEY_NAMES[lower];
  if (named) return named;
  // A key range such as "1–9" (a collapsed numbered family) reads as a range.
  const range = /^(\w)[–-](\w)$/.exec(rawToken);
  if (range) return `${range[1]!.toUpperCase()} through ${range[2]!.toUpperCase()}`;
  if (rawToken.length === 1) return rawToken.toUpperCase();
  return rawToken;
}

/**
 * The shortcut as it should be read aloud: `"Cmd+K Cmd+S"` →
 * `"Command K, then Command S"` on macOS, `"Ctrl K, then Ctrl S"` elsewhere.
 * Returns `""` for an empty shortcut.
 */
export function describeChord(shortcut: string, isMac: boolean): string {
  if (!shortcut || !shortcut.trim()) return "";
  const normalized = shortcut.trim().replace(/\s*\+\s*/g, "+");
  return normalized
    .split(/\s+/)
    .map((step) => splitStepKeys(step))
    .filter((tokens) => tokens.length > 0)
    .map((tokens) => tokens.map((token) => spokenToken(token, isMac)).join(" "))
    .join(", then ");
}
