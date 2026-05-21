// @vitest-environment jsdom
import { render } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { Kbd, KbdChord } from "../Kbd";

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

  it("applies tabular-nums so digit and letter keys align (issue #8100)", () => {
    const { container } = render(<Kbd>Esc</Kbd>);
    const kbd = container.querySelector("kbd");
    expect(kbd?.className).toContain("tabular-nums");
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

  it("falls back to shortcut string for accessible text when aria-label is not provided", () => {
    const { container } = render(<KbdChord shortcut="Cmd+S" />);
    const label = container.querySelector(".sr-only");
    expect(label?.textContent).toBe("Cmd+S");
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
