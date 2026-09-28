// @vitest-environment jsdom
import { render } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { Kbd, KbdChord } from "../Kbd";
import { describeChord, formatChordText } from "@/lib/kbdShortcut";

vi.mock("@/lib/platform", () => ({
  isMac: vi.fn(() => false),
}));

vi.mock("@/lib/utils", () => ({
  cn: (...args: unknown[]) => args.filter(Boolean).join(" "),
}));

describe("Kbd", () => {
  it("renders children inside a kbd element", () => {
    const { container } = render(<Kbd>Esc</Kbd>);
    const kbd = container.querySelector("kbd");
    expect(kbd).toBeTruthy();
    expect(kbd?.textContent).toBe("Esc");
  });
});

describe("KbdChord", () => {
  it("outer wrapper is a span so ARIA labels do not land on kbd", () => {
    const { container } = render(<KbdChord shortcut="Cmd+S" />);
    const root = container.firstElementChild;
    expect(root?.tagName.toLowerCase()).toBe("span");
  });

  it("inner per-key kbd elements have aria-hidden to prevent AT double-announcement", () => {
    const { container } = render(<KbdChord shortcut="Cmd+S" />);
    const innerKbds = container.querySelectorAll("span kbd");
    expect(innerKbds.length).toBeGreaterThan(0);
    innerKbds.forEach((kbd) => {
      expect(kbd.getAttribute("aria-hidden")).toBe("true");
    });
  });

  it("renders an accessible text label when provided", () => {
    const { container } = render(<KbdChord shortcut="Cmd+S" aria-label="Save file" />);
    const label = container.querySelector(".sr-only");
    expect(label?.textContent).toBe("Save file");
  });

  it("falls back to the spoken form, not glyphs or the raw string, without an aria-label", () => {
    for (const isMac of [true, false]) {
      const { container, unmount } = render(
        <KbdChord shortcut="Cmd+Shift+K Cmd+S" isMac={isMac} />
      );
      const spoken = container.querySelector(".sr-only")?.textContent ?? "";
      expect(spoken).toBe(describeChord("Cmd+Shift+K Cmd+S", isMac));
      expect(spoken).not.toMatch(/[⌘⌥⇧⌃+]/);
      unmount();
    }
  });

  it("renders chord with multiple steps", () => {
    const { container } = render(<KbdChord shortcut="Cmd+K Cmd+S" />);
    const innerKbds = container.querySelectorAll("span kbd");
    expect(innerKbds.length).toBeGreaterThanOrEqual(4);
  });

  it("applies tabular-nums on per-key pills so digit and letter keys align (issue #8100)", () => {
    const { container } = render(<KbdChord shortcut="Cmd+S" />);
    const innerKbds = container.querySelectorAll("span kbd");
    expect(innerKbds.length).toBeGreaterThan(0);
    innerKbds.forEach((kbd) => {
      expect(kbd.className).toContain("tabular-nums");
    });
  });

  it("applies tabular-nums on digit-token pills — the issue's stated scenario (#8100)", () => {
    const { container } = render(<KbdChord shortcut="Cmd+1" isMac={false} />);
    const innerKbds = container.querySelectorAll("span kbd");
    expect(innerKbds.length).toBeGreaterThan(0);
    innerKbds.forEach((kbd) => {
      expect(kbd.className).toContain("tabular-nums");
    });
  });
});

describe("KbdChord modifier glyph face", () => {
  it.each(["default", "compact", "bare"] as const)(
    "sets every macOS key glyph in one face and every other key in mono (%s)",
    (density) => {
      // The glyphs JetBrains Mono's subset lacks: the modifiers, the named keys
      // macOS also draws as symbols (Return, Escape, Tab, Delete), and arrows.
      const { container } = render(
        <KbdChord
          shortcut="Ctrl+Alt+Shift+Cmd+K Cmd+Enter Shift+Escape Tab Cmd+Backspace Alt+Up"
          isMac
          density={density}
        />
      );
      const chips = Array.from(container.querySelectorAll("kbd"));
      const glyphs = chips.filter((k) => /^[⌘⇧⌥⌃⏎⎋⇥⌫⌦↑↓←→]$/.test(k.textContent ?? ""));
      const others = chips.filter((k) => !glyphs.includes(k));
      expect(glyphs.length).toBe(13);
      expect(others.length).toBeGreaterThan(0);

      const face = (k: Element) =>
        k.className.split(/\s+/).filter((c) => /^font-(mono|sans)$/.test(c));
      for (const k of glyphs) expect(face(k)).toEqual([face(glyphs[0]!)[0]]);
      expect(face(glyphs[0]!)).not.toEqual(["font-mono"]);
      for (const k of others) expect(face(k)).toEqual(["font-mono"]);
      for (const k of chips) expect(k.className).toContain("leading-none");
    }
  );
});

describe("formatChordText", () => {
  // A string-only surface (a native title) and the chips must print one
  // grammar. The chips' visible text is the reference, read off the DOM with
  // the spoken sr-only label removed.
  const COMBOS = ["Cmd+Shift+P", "Alt+P", "Ctrl+Shift+F", "Cmd+K Cmd+R", "Cmd++", "Shift+Enter"];

  function chipText(shortcut: string, mac: boolean): string {
    const { container, unmount } = render(<KbdChord shortcut={shortcut} isMac={mac} />);
    container.querySelector(".sr-only")?.remove();
    const text = (container.textContent ?? "").replace(/,/g, ", ");
    unmount();
    return text;
  }

  it.each([true, false])("prints exactly what KbdChord draws (mac=%s)", (mac) => {
    for (const combo of COMBOS) expect(formatChordText(combo, mac)).toBe(chipText(combo, mac));
  });

  it("never joins macOS glyphs with a plus, and always joins Windows names with one", () => {
    expect(formatChordText("Cmd+Shift+P", true)).not.toMatch(/[⌘⇧⌥⌃]\+/);
    expect(formatChordText("Cmd+Shift+P", false)).toMatch(/^\w+\+\w+\+\w+$/);
  });
});
