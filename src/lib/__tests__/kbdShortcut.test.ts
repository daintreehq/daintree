import { describe, it, expect } from "vitest";
import {
  describeChord,
  parseChord,
  MODIFIER_SEARCH_MAP,
  VALID_KEY_PATTERN,
  isChordPrefix,
  normalizeQuery,
  comboToAriaKeyshortcuts,
} from "../kbdShortcut";
import { buildDefaultKeybindings } from "@shared/config/defaultKeybindings";

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

  it("keeps a literal plus key as its own chord step", () => {
    expect(parseChord("Cmd+K +", true)).toEqual([["⌘", "K"], ["+"]]);
    expect(parseChord("Cmd+K +", false)).toEqual([["Ctrl", "K"], ["+"]]);
  });

  it("keeps a trailing literal plus from swallowing the next step", () => {
    expect(parseChord("Cmd++ Cmd+P", true)).toEqual([
      ["⌘", "+"],
      ["⌘", "P"],
    ]);
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

describe("comboToAriaKeyshortcuts — macOS modifier mapping", () => {
  it("maps Cmd to Meta on macOS", () => {
    expect(comboToAriaKeyshortcuts("Cmd+P", true)).toBe("Meta+P");
    expect(comboToAriaKeyshortcuts("Command+P", true)).toBe("Meta+P");
    expect(comboToAriaKeyshortcuts("Meta+P", true)).toBe("Meta+P");
  });

  it("maps Ctrl/Control to Control on macOS", () => {
    expect(comboToAriaKeyshortcuts("Ctrl+A", true)).toBe("Control+A");
    expect(comboToAriaKeyshortcuts("Control+A", true)).toBe("Control+A");
  });

  it("maps Option/Alt to Alt on macOS", () => {
    expect(comboToAriaKeyshortcuts("Option+T", true)).toBe("Alt+T");
    expect(comboToAriaKeyshortcuts("Alt+T", true)).toBe("Alt+T");
  });

  it("preserves Shift", () => {
    expect(comboToAriaKeyshortcuts("Cmd+Shift+P", true)).toBe("Meta+Shift+P");
  });
});

describe("comboToAriaKeyshortcuts — Win/Linux modifier mapping", () => {
  it("maps Cmd to Control on Win/Linux (matches the runtime Cmd→Ctrl swap)", () => {
    expect(comboToAriaKeyshortcuts("Cmd+P", false)).toBe("Control+P");
    expect(comboToAriaKeyshortcuts("Command+P", false)).toBe("Control+P");
    expect(comboToAriaKeyshortcuts("Meta+P", false)).toBe("Control+P");
  });

  it("keeps Ctrl as Control", () => {
    expect(comboToAriaKeyshortcuts("Ctrl+Shift+P", false)).toBe("Control+Shift+P");
  });

  it("maps Option/Alt to Alt", () => {
    expect(comboToAriaKeyshortcuts("Option+T", false)).toBe("Alt+T");
    expect(comboToAriaKeyshortcuts("Alt+T", false)).toBe("Alt+T");
  });
});

describe("comboToAriaKeyshortcuts — special key names", () => {
  it("uses canonical KeyboardEvent key names for named keys", () => {
    expect(comboToAriaKeyshortcuts("Cmd+Return", true)).toBe("Meta+Enter");
    expect(comboToAriaKeyshortcuts("Cmd+Enter", true)).toBe("Meta+Enter");
    expect(comboToAriaKeyshortcuts("Escape", true)).toBe("Escape");
    expect(comboToAriaKeyshortcuts("Esc", true)).toBe("Escape");
    expect(comboToAriaKeyshortcuts("Tab", true)).toBe("Tab");
    expect(comboToAriaKeyshortcuts("Backspace", true)).toBe("Backspace");
    expect(comboToAriaKeyshortcuts("Delete", true)).toBe("Delete");
    expect(comboToAriaKeyshortcuts("Del", true)).toBe("Delete");
  });

  it("maps arrow names to ArrowUp/ArrowDown/ArrowLeft/ArrowRight", () => {
    expect(comboToAriaKeyshortcuts("Cmd+Up", true)).toBe("Meta+ArrowUp");
    expect(comboToAriaKeyshortcuts("Cmd+ArrowDown", true)).toBe("Meta+ArrowDown");
    expect(comboToAriaKeyshortcuts("Ctrl+Left", false)).toBe("Control+ArrowLeft");
    expect(comboToAriaKeyshortcuts("Ctrl+ArrowRight", false)).toBe("Control+ArrowRight");
  });

  it("preserves multi-char unknown tokens (PageUp, NumpadEnter)", () => {
    expect(comboToAriaKeyshortcuts("PageUp", true)).toBe("PageUp");
    expect(comboToAriaKeyshortcuts("Cmd+NumpadEnter", true)).toBe("Meta+NumpadEnter");
  });
});

describe("comboToAriaKeyshortcuts — chord sequences", () => {
  // ARIA uses spaces to separate alternative shortcuts, not chord steps.
  // The function returns undefined so the attribute is omitted entirely
  // rather than mislabelling the binding as a list of alternatives.
  it("returns undefined for two-step chords", () => {
    expect(comboToAriaKeyshortcuts("Cmd+K T", true)).toBeUndefined();
    expect(comboToAriaKeyshortcuts("Cmd+K T", false)).toBeUndefined();
  });

  it("returns undefined for two-step chords with shared prefix", () => {
    expect(comboToAriaKeyshortcuts("Cmd+K Cmd+W", true)).toBeUndefined();
    expect(comboToAriaKeyshortcuts("Cmd+K Cmd+W", false)).toBeUndefined();
  });

  it("returns undefined for chords with extra whitespace between steps", () => {
    expect(comboToAriaKeyshortcuts("Cmd+K   T", true)).toBeUndefined();
  });
});

describe("comboToAriaKeyshortcuts — real default-combo round-trips", () => {
  // Anchors the converter against representative bindings from
  // defaultKeybindings.ts so a future raw-combo refactor cannot silently
  // change what ends up in the accessibility tree.
  it("maps panel toggles (Cmd+B → Meta+B / Control+B)", () => {
    expect(comboToAriaKeyshortcuts("Cmd+B", true)).toBe("Meta+B");
    expect(comboToAriaKeyshortcuts("Cmd+B", false)).toBe("Control+B");
  });

  it("maps multi-modifier combos (Cmd+Shift+P, Cmd+Alt+P)", () => {
    expect(comboToAriaKeyshortcuts("Cmd+Shift+P", true)).toBe("Meta+Shift+P");
    expect(comboToAriaKeyshortcuts("Cmd+Alt+P", false)).toBe("Control+Alt+P");
  });

  it("maps the Cmd+Shift+= zoom-in alias (issue #7304)", () => {
    expect(comboToAriaKeyshortcuts("Cmd+Shift+=", true)).toBe("Meta+Shift+=");
    expect(comboToAriaKeyshortcuts("Cmd+Shift+=", false)).toBe("Control+Shift+=");
  });

  it("returns undefined for two-step chord families (Cmd+K Cmd+S, Cmd+K T)", () => {
    expect(comboToAriaKeyshortcuts("Cmd+K Cmd+S", true)).toBeUndefined();
    expect(comboToAriaKeyshortcuts("Cmd+K Cmd+S", false)).toBeUndefined();
    expect(comboToAriaKeyshortcuts("Cmd+K T", true)).toBeUndefined();
    expect(comboToAriaKeyshortcuts("Cmd+K T", false)).toBeUndefined();
  });
});

describe("comboToAriaKeyshortcuts — edge cases", () => {
  it("returns undefined for null/undefined/empty input", () => {
    expect(comboToAriaKeyshortcuts(undefined, true)).toBeUndefined();
    expect(comboToAriaKeyshortcuts(null, true)).toBeUndefined();
    expect(comboToAriaKeyshortcuts("", true)).toBeUndefined();
    expect(comboToAriaKeyshortcuts("   ", true)).toBeUndefined();
  });

  it("spells a literal + key as Plus (Ctrl++)", () => {
    expect(comboToAriaKeyshortcuts("Ctrl++", false)).toBe("Control+Plus");
    expect(comboToAriaKeyshortcuts("Cmd+Shift++", true)).toBe("Meta+Shift+Plus");
  });

  it("uppercases single-char keys", () => {
    expect(comboToAriaKeyshortcuts("Cmd+p", true)).toBe("Meta+P");
    expect(comboToAriaKeyshortcuts("Cmd+1", true)).toBe("Meta+1");
  });

  it("is case-insensitive for modifiers", () => {
    expect(comboToAriaKeyshortcuts("CMD+SHIFT+P", true)).toBe("Meta+Shift+P");
    expect(comboToAriaKeyshortcuts("cmd+shift+p", true)).toBe("Meta+Shift+P");
  });

  it("trims whitespace around + separators", () => {
    expect(comboToAriaKeyshortcuts(" Cmd + Shift + P ", true)).toBe("Meta+Shift+P");
  });

  it("passes through unknown modifier-style tokens unchanged", () => {
    expect(comboToAriaKeyshortcuts("Hyper+P", true)).toBe("Hyper+P");
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

describe("describeChord", () => {
  const combos = buildDefaultKeybindings(false)
    .map((binding) => binding.combo)
    .filter((combo) => combo.length > 0);

  it("never speaks a glyph for any shipped binding, on either platform", () => {
    for (const combo of combos) {
      for (const mac of [true, false]) {
        const spoken = describeChord(combo, mac);
        expect(spoken, combo).not.toMatch(/[⌘⌥⇧⌃⏎⎋⇥⌫⌦↑↓←→]/);
        expect(spoken.trim().length, combo).toBeGreaterThan(0);
      }
    }
  });

  it("says 'then' once between each pair of chord steps", () => {
    for (const combo of combos) {
      const steps = parseChord(combo, true).length;
      expect(describeChord(combo, true).split(", then ").length, combo).toBe(steps);
    }
  });

  it("names every key of a step, in order", () => {
    for (const combo of combos) {
      const stepKeys = parseChord(combo, false).map((keys) => keys.length);
      const spokenKeys = describeChord(combo, false)
        .split(", then ")
        .map((step) => step.split(" ").filter((word) => /^[A-Z0-9]/.test(word)).length);
      stepKeys.forEach((count, i) => expect(spokenKeys[i], combo).toBeGreaterThanOrEqual(count));
    }
  });

  it("uses each platform's own modifier names", () => {
    expect(describeChord("Cmd+Alt+T", true)).not.toBe(describeChord("Cmd+Alt+T", false));
    expect(describeChord("Cmd+Alt+T", false)).not.toMatch(/Command|Option/);
  });

  it("reads a key range as a range", () => {
    expect(describeChord("Cmd+Alt+1–9", true)).toMatch(/1 through 9$/);
  });

  it("returns an empty string for an empty shortcut", () => {
    expect(describeChord("", true)).toBe("");
  });

  it("omits every sequence the chips show as more than one step", () => {
    const edgeCases = ["Cmd++ Cmd+P", "Cmd+K +", "Cmd+K  Cmd+S", "Ctrl++", "Cmd+Shift+P"];
    for (const combo of [...edgeCases, ...combos]) {
      for (const mac of [true, false]) {
        const aria = comboToAriaKeyshortcuts(combo, mac);
        if (parseChord(combo, mac).length > 1) expect(aria, combo).toBeUndefined();
        else expect(aria, combo).not.toMatch(/\+\+|\+$/);
      }
    }
  });

  it("speaks exactly the steps and keys the chips show, literal plus included", () => {
    const edgeCases = ["Cmd++ Cmd+P", "Cmd+K +", "Ctrl++", " Cmd + Shift + P ", "Cmd+K  Cmd+S"];
    for (const combo of [...edgeCases, ...combos]) {
      for (const mac of [true, false]) {
        const shown = parseChord(combo, mac);
        const spoken = describeChord(combo, mac).split(", then ");
        expect(spoken.length, combo).toBe(shown.length);
        spoken.forEach((step, i) => {
          if (shown[i]!.includes("+")) expect(step, combo).toMatch(/\bPlus\b/);
        });
      }
    }
  });
});
