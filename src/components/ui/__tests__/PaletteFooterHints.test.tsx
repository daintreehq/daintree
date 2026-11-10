// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/utils", () => ({
  cn: (...args: unknown[]) => args.filter(Boolean).join(" "),
}));

vi.mock("@/hooks/useOverlayState", () => ({
  useOverlayState: () => {},
}));

vi.mock("@/store/paletteStore", () => ({
  usePaletteStore: { getState: () => ({ activePaletteId: null }) },
}));

vi.mock("@/lib/platform", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/platform")>()),
  isMac: vi.fn(() => true),
}));

import * as platform from "@/lib/platform";
import { PaletteFooterHints } from "../AppPaletteDialog";

afterEach(() => {
  cleanup();
  vi.mocked(platform.isMac).mockReturnValue(true);
});

function capsOf(label: string): string[] {
  const chip = screen.getByText(label).parentElement!;
  return [...chip.querySelectorAll("kbd")].map((kbd) => kbd.textContent ?? "");
}

function spokenOf(label: string): string {
  return screen.getByText(label).parentElement!.querySelector(".sr-only")?.textContent ?? "";
}

/** The footer width, in px, at or under which a chip hides. */
function dropWidthOf(label: string): number {
  const match = /@max-\[(\d+)px\]\/palette-footer:hidden/.exec(
    screen.getByText(label).parentElement!.className
  );
  return match ? Number(match[1]) : 0;
}

describe("PaletteFooterHints", () => {
  const defaultProps = {
    primaryHint: { keys: "Enter", label: "to create" },
    hints: [
      { keys: "Shift+F10", label: "to open actions" },
      { keys: "Escape", label: "to go back" },
    ],
  };

  it("names every key the way macOS does on a Mac", () => {
    render(<PaletteFooterHints {...defaultProps} />);
    expect(capsOf("to create")).toEqual(["⏎"]);
    expect(capsOf("to open actions")).toEqual(["⇧", "F10"]);
    expect(capsOf("to go back")).toEqual(["⎋"]);
  });

  it("spells the keys out on Windows and Linux, with no Mac glyph anywhere", () => {
    vi.mocked(platform.isMac).mockReturnValue(false);
    const { container } = render(<PaletteFooterHints {...defaultProps} />);
    expect(capsOf("to create")).toEqual(["Enter"]);
    expect(capsOf("to open actions")).toEqual(["Shift", "F10"]);
    expect(capsOf("to go back")).toEqual(["Esc"]);
    expect(container.textContent).not.toMatch(/[⌘⌥⌃⇧⏎↵⎋⌫]/);
  });

  it("speaks each chip's keys by name and hides the caps themselves", () => {
    const { container } = render(<PaletteFooterHints {...defaultProps} />);
    const caps = container.querySelectorAll("kbd");
    expect(caps).toHaveLength(4);
    for (const cap of caps) expect(cap.getAttribute("aria-hidden")).toBe("true");
    // Words a listener can use, never the glyphs a screen reader mangles.
    expect(spokenOf("to create")).toBe("Return");
    expect(spokenOf("to open actions")).toBe("Shift F10");
    expect(spokenOf("to go back")).toBe("Escape");
  });

  it("draws a keyless chip as its words alone", () => {
    const { container } = render(
      <PaletteFooterHints
        primaryHint={{ keys: "Enter", label: "to switch" }}
        hints={[{ label: "Saved: Nord" }]}
      />
    );
    expect(screen.getByText("Saved: Nord")).toBeTruthy();
    // The one cap and the one spoken key are the Enter hint's.
    expect([...container.querySelectorAll("kbd")].map((kbd) => kbd.textContent)).toEqual(["⏎"]);
    expect(container.querySelectorAll(".sr-only")).toHaveLength(1);
  });

  it("renders all secondary hints ambient — no popover, no help button", () => {
    render(<PaletteFooterHints {...defaultProps} />);
    expect(screen.getByText("to open actions")).toBeTruthy();
    expect(screen.getByText("to go back")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /keyboard shortcuts/i })).toBeNull();
  });

  it("drops secondaries from the trailing edge as the footer narrows", () => {
    const { container } = render(
      <PaletteFooterHints
        primaryHint={{ keys: "Enter", label: "to switch" }}
        hints={[
          { keys: "Space", label: "to select" },
          { keys: "F2", label: "to browse sessions" },
          { keys: "Shift+F10", label: "to open actions" },
          { keys: "Escape", label: "to go back" },
        ]}
      />
    );
    const widths = ["to select", "to browse sessions", "to open actions", "to go back"].map(
      dropWidthOf
    );
    // Each chip hides at a wider footer than the one before it, so the last
    // goes first; a fourth shares the narrowest width rather than never hiding.
    expect(widths[3]).toBeGreaterThan(widths[2]!);
    expect(widths[2]).toBeGreaterThan(widths[1]!);
    expect(widths[1]).toBe(widths[0]);
    expect(widths[0]).toBeGreaterThan(0);
    // The primary never hides.
    expect(dropWidthOf("to switch")).toBe(0);
    // The variants query the wrapper by name; without it none would ever fire.
    expect((container.firstChild as HTMLElement).className).toMatch(/@container\/palette-footer\b/);
  });

  it("keeps a lone secondary longer than the last of a crowded row", () => {
    const secondaries = [
      { keys: "Space", label: "to select" },
      { keys: "F2", label: "to browse sessions" },
      { keys: "Shift+F10", label: "to open actions" },
    ];
    const primaryHint = { keys: "Enter", label: "to switch" };
    render(<PaletteFooterHints primaryHint={primaryHint} hints={secondaries} />);
    const crowded = dropWidthOf("to open actions");
    cleanup();
    render(<PaletteFooterHints primaryHint={primaryHint} hints={secondaries.slice(2)} />);
    // One chip beside the primary needs far less room than three, so it should
    // not drop at the width that sheds the third of three.
    expect(dropWidthOf("to open actions")).toBeLessThan(crowded);
  });
});
