import { describe, it, expect } from "vitest";
import { parseChord } from "../kbdShortcut";

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
