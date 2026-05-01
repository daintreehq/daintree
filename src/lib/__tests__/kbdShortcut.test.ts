import { describe, it, expect } from "vitest";
import {
  parseChord,
  MODIFIER_SEARCH_MAP,
  VALID_KEY_PATTERN,
  isChordPrefix,
  normalizeQuery,
} from "../kbdShortcut";

describe("parseChord — macOS glyphs", () => {
  it("maps Cmd/Option/Shift/Ctrl to glyphs", () => {
    expect(parseChord("Cmd+Shift+P", true)).toEqual([["⌘", "⇧", "P"]]);
    expect(parseChord("Ctrl+Option+T", true)).toEqual([["⌃", "⌥", "T"]]);
  });

  it("maps Return/Enter to ⏎", () => {
    expect(parseChord("Cmd+Return", true)).toEqual([["⌘", "⏎"]]);
    expect(parseChord("Cmd+Enter", true)).toEqual([["⌘", "⏎"]]);
  });

  it("maps Escape/Esc to ⎋", () => {
    expect(parseChord("Escape", true)).toEqual([["⎋"]]);
    expect(parseChord("Esc", true)).toEqual([["⎋"]]);
  });

  it("maps Tab/Backspace/Delete glyphs", () => {
    expect(parseChord("Tab", true)).toEqual([["⇥"]]);
    expect(parseChord("Backspace", true)).toEqual([["⌫"]]);
    expect(parseChord("Delete", true)).toEqual([["⌦"]]);
    expect(parseChord("Del", true)).toEqual([["⌦"]]);
  });

  it("maps modifier aliases (cmd/command/meta) to ⌘", () => {
    expect(parseChord("Cmd+P", true)).toEqual([["⌘", "P"]]);
    expect(parseChord("Command+P", true)).toEqual([["⌘", "P"]]);
    expect(parseChord("Meta+P", true)).toEqual([["⌘", "P"]]);
  });

  it("maps ctrl/control to ⌃", () => {
    expect(parseChord("Ctrl+A", true)).toEqual([["⌃", "A"]]);
    expect(parseChord("Control+A", true)).toEqual([["⌃", "A"]]);
  });

  it("maps option/alt to ⌥", () => {
    expect(parseChord("Option+T", true)).toEqual([["⌥", "T"]]);
    expect(parseChord("Alt+T", true)).toEqual([["⌥", "T"]]);
  });
});

describe("parseChord — Win/Linux spelled-out", () => {
  it("maps Cmd/Command/Meta to Ctrl", () => {
    expect(parseChord("Cmd+P", false)).toEqual([["Ctrl", "P"]]);
    expect(parseChord("Command+P", false)).toEqual([["Ctrl", "P"]]);
    expect(parseChord("Meta+P", false)).toEqual([["Ctrl", "P"]]);
  });

  it("keeps Ctrl as Ctrl", () => {
    expect(parseChord("Ctrl+Shift+P", false)).toEqual([["Ctrl", "Shift", "P"]]);
  });

  it("maps Option to Alt", () => {
    expect(parseChord("Option+T", false)).toEqual([["Alt", "T"]]);
    expect(parseChord("Alt+T", false)).toEqual([["Alt", "T"]]);
  });

  it("uses spelled-out Enter/Esc/Tab/Backspace/Delete", () => {
    expect(parseChord("Return", false)).toEqual([["Enter"]]);
    expect(parseChord("Escape", false)).toEqual([["Esc"]]);
    expect(parseChord("Tab", false)).toEqual([["Tab"]]);
    expect(parseChord("Backspace", false)).toEqual([["Backspace"]]);
    expect(parseChord("Delete", false)).toEqual([["Delete"]]);
  });
});

describe("parseChord — arrow keys (glyphs on every platform)", () => {
  it("renders arrows as glyphs on macOS", () => {
    expect(parseChord("Cmd+Up", true)).toEqual([["⌘", "↑"]]);
    expect(parseChord("Cmd+Down", true)).toEqual([["⌘", "↓"]]);
    expect(parseChord("Cmd+Left", true)).toEqual([["⌘", "←"]]);
    expect(parseChord("Cmd+Right", true)).toEqual([["⌘", "→"]]);
  });

  it("renders arrows as glyphs on Win/Linux", () => {
    expect(parseChord("Ctrl+Up", false)).toEqual([["Ctrl", "↑"]]);
    expect(parseChord("Ctrl+ArrowDown", false)).toEqual([["Ctrl", "↓"]]);
  });
});

describe("parseChord — multi-step chords", () => {
  it("splits on whitespace into chord steps", () => {
    expect(parseChord("Cmd+K T", true)).toEqual([["⌘", "K"], ["T"]]);
  });

  it("handles two-step chords with shared prefix", () => {
    expect(parseChord("Cmd+K Cmd+W", true)).toEqual([
      ["⌘", "K"],
      ["⌘", "W"],
    ]);
  });

  it("collapses extra whitespace between steps", () => {
    expect(parseChord("Cmd+K   T", true)).toEqual([["⌘", "K"], ["T"]]);
  });
});

describe("parseChord — edge cases", () => {
  it("returns [] for empty string", () => {
    expect(parseChord("", true)).toEqual([]);
  });

  it("returns [] for whitespace only", () => {
    expect(parseChord("   ", true)).toEqual([]);
  });

  it("handles literal + key (Ctrl++)", () => {
    expect(parseChord("Ctrl++", false)).toEqual([["Ctrl", "+"]]);
    expect(parseChord("Ctrl++", true)).toEqual([["⌃", "+"]]);
  });

  it("handles literal + key with shift", () => {
    expect(parseChord("Cmd+Shift++", true)).toEqual([["⌘", "⇧", "+"]]);
  });

  it("passes through unknown tokens (Hyper)", () => {
    expect(parseChord("Hyper+P", true)).toEqual([["Hyper", "P"]]);
  });

  it("is case insensitive", () => {
    expect(parseChord("CMD+SHIFT+P", true)).toEqual([["⌘", "⇧", "P"]]);
    expect(parseChord("cmd+shift+p", true)).toEqual([["⌘", "⇧", "P"]]);
  });

  it("trims whitespace around + separators", () => {
    expect(parseChord(" Cmd + Shift + P ", true)).toEqual([["⌘", "⇧", "P"]]);
  });

  it("treats a bare + as a literal + key", () => {
    expect(parseChord("+", false)).toEqual([["+"]]);
  });

  it("ignores a single trailing + (Ctrl+ alone) as malformed", () => {
    expect(parseChord("Ctrl+", false)).toEqual([["Ctrl"]]);
  });

  it("preserves casing of unknown multi-char tokens (PageUp)", () => {
    expect(parseChord("PageUp", false)).toEqual([["PageUp"]]);
    expect(parseChord("Cmd+NumpadEnter", true)).toEqual([["⌘", "NumpadEnter"]]);
  });
});

describe("MODIFIER_SEARCH_MAP", () => {
  it("maps text aliases to canonical IDs", () => {
    expect(MODIFIER_SEARCH_MAP["cmd"]).toBe("cmd");
    expect(MODIFIER_SEARCH_MAP["command"]).toBe("cmd");
    expect(MODIFIER_SEARCH_MAP["meta"]).toBe("cmd");
    expect(MODIFIER_SEARCH_MAP["ctrl"]).toBe("ctrl");
    expect(MODIFIER_SEARCH_MAP["control"]).toBe("ctrl");
    expect(MODIFIER_SEARCH_MAP["alt"]).toBe("alt");
    expect(MODIFIER_SEARCH_MAP["option"]).toBe("alt");
    expect(MODIFIER_SEARCH_MAP["shift"]).toBe("shift");
  });

  it("maps unicode symbols to canonical IDs", () => {
    expect(MODIFIER_SEARCH_MAP["⌘"]).toBe("cmd");
    expect(MODIFIER_SEARCH_MAP["⌃"]).toBe("ctrl");
    expect(MODIFIER_SEARCH_MAP["⌥"]).toBe("alt");
    expect(MODIFIER_SEARCH_MAP["⇧"]).toBe("shift");
  });
});

describe("VALID_KEY_PATTERN", () => {
  it("matches single letters, digits, and punctuation", () => {
    expect(VALID_KEY_PATTERN.test("a")).toBe(true);
    expect(VALID_KEY_PATTERN.test("Z")).toBe(true);
    expect(VALID_KEY_PATTERN.test("0")).toBe(true);
    expect(VALID_KEY_PATTERN.test("`")).toBe(true);
    expect(VALID_KEY_PATTERN.test(",")).toBe(true);
    expect(VALID_KEY_PATTERN.test("/")).toBe(true);
  });

  it("rejects multi-character tokens", () => {
    expect(VALID_KEY_PATTERN.test("ab")).toBe(false);
    expect(VALID_KEY_PATTERN.test("F1")).toBe(false);
  });

  it("rejects empty string", () => {
    expect(VALID_KEY_PATTERN.test("")).toBe(false);
  });
});

describe("isChordPrefix", () => {
  it("returns true for text modifier + key (cmd+k)", () => {
    expect(isChordPrefix("cmd+k")).toBe(true);
  });

  it("returns true for unicode symbol + key (⌘k)", () => {
    expect(isChordPrefix("⌘k")).toBe(true);
  });

  it("returns true for multiple modifiers (cmd+shift+p)", () => {
    expect(isChordPrefix("cmd+shift+p")).toBe(true);
  });

  it("returns false for unicode multiple modifiers without separator (⌘⇧p)", () => {
    // Falls back to fuzzy search — separators are required for multi-modifier detection
    expect(isChordPrefix("⌘⇧p")).toBe(false);
  });

  it("returns true for space-separated chord (cmd k)", () => {
    expect(isChordPrefix("cmd k")).toBe(true);
  });

  it("returns false for bare modifier (cmd)", () => {
    expect(isChordPrefix("cmd")).toBe(false);
  });

  it("returns false for bare unicode modifier (⌘)", () => {
    expect(isChordPrefix("⌘")).toBe(false);
  });

  it("returns false for empty string", () => {
    expect(isChordPrefix("")).toBe(false);
  });

  it("returns false for non-modifier word (toggle)", () => {
    expect(isChordPrefix("toggle")).toBe(false);
  });

  it("returns false for modifier-like word without separator (commander)", () => {
    expect(isChordPrefix("commander")).toBe(false);
  });

  it("returns false for trailing separator without key (cmd+)", () => {
    expect(isChordPrefix("cmd+")).toBe(false);
  });

  it("is case insensitive (CMD+K)", () => {
    expect(isChordPrefix("CMD+K")).toBe(true);
  });
});

describe("normalizeQuery", () => {
  it("replaces unicode symbols with text equivalents", () => {
    expect(normalizeQuery("⌘k")).toBe("cmdk");
    expect(normalizeQuery("⌘+k")).toBe("cmd+k");
    expect(normalizeQuery("⌘⇧p")).toBe("cmdshiftp");
  });

  it("collapses whitespace and normalizes separators", () => {
    expect(normalizeQuery("cmd + k")).toBe("cmd+k");
    expect(normalizeQuery("cmd   k")).toBe("cmd+k");
  });

  it("returns already-canonical input unchanged", () => {
    expect(normalizeQuery("cmd+shift+p")).toBe("cmd+shift+p");
  });

  it("lowercases input", () => {
    expect(normalizeQuery("CMD+K")).toBe("cmd+k");
  });

  it("preserves plain-text words containing modifier substrings", () => {
    expect(normalizeQuery("metadata")).toBe("metadata");
    expect(normalizeQuery("optional")).toBe("optional");
    expect(normalizeQuery("toggle")).toBe("toggle");
  });

  it("canonicalizes whole-token modifier aliases", () => {
    expect(normalizeQuery("command+shift+p")).toBe("cmd+shift+p");
    expect(normalizeQuery("command palette")).toBe("cmd+palette");
  });
});

describe("parseChord — pre-glyphed input (formatComboForDisplay → KbdChord pipeline)", () => {
  it("splits pre-glyphed single-modifier on + separator (⌘+B)", () => {
    expect(parseChord("⌘+B", true)).toEqual([["⌘", "B"]]);
  });

  it("splits pre-glyphed multi-modifier on + separator (⌘+⇧+B)", () => {
    expect(parseChord("⌘+⇧+B", true)).toEqual([["⌘", "⇧", "B"]]);
  });

  it("splits pre-glyphed combo with Option (⌘+⌥+T)", () => {
    expect(parseChord("⌘+⌥+T", true)).toEqual([["⌘", "⌥", "T"]]);
  });

  it("splits pre-glyphed combo with Ctrl (⌃+⌘+F)", () => {
    expect(parseChord("⌃+⌘+F", true)).toEqual([["⌃", "⌘", "F"]]);
  });

  it("preserves unknown glyphed tokens as-is", () => {
    expect(parseChord("⌘+X", true)).toEqual([["⌘", "X"]]);
  });
});
