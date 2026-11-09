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

  it("speaks the keys by name and hides the caps themselves", () => {
    const { container } = render(<PaletteFooterHints {...defaultProps} />);
    for (const cap of container.querySelectorAll("kbd")) {
      expect(cap.getAttribute("aria-hidden")).toBe("true");
    }
    const spoken = [...container.querySelectorAll(".sr-only")].map((el) => el.textContent);
    expect(spoken).toHaveLength(3);
    // Each spoken name is words, never the glyph a screen reader would mangle.
    for (const text of spoken) expect(text).toMatch(/^[A-Za-z0-9 ]+$/);
    expect(spoken[1]).toContain("Shift");
  });

  it("draws a keyless chip as its words alone", () => {
    render(
      <PaletteFooterHints
        primaryHint={{ keys: "Enter", label: "to switch" }}
        hints={[{ label: "Saved: Nord" }]}
      />
    );
    const chip = screen.getByText("Saved: Nord");
    expect(chip.parentElement!.querySelector("kbd")).toBeNull();
    expect(chip.className).not.toContain("ml-1.5");
  });

  it("renders all secondary hints ambient — no popover, no help button", () => {
    render(<PaletteFooterHints {...defaultProps} />);
    expect(screen.getByText("to open actions")).toBeTruthy();
    expect(screen.getByText("to go back")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /keyboard shortcuts/i })).toBeNull();
  });

  it("applies width-priority drop classes — last hint hides earliest", () => {
    const { container } = render(<PaletteFooterHints {...defaultProps} />);
    const escChip = screen.getByText("to go back").parentElement;
    const actionsChip = screen.getByText("to open actions").parentElement;
    // Esc is rightmost (index 1 of 2) → from-end index 0 → highest breakpoint.
    expect(escChip?.className).toContain("@max-[380px]/palette-footer:hidden");
    // Shift+F10 is index 0 of 2 → from-end index 1 → lower breakpoint.
    expect(actionsChip?.className).toContain("@max-[280px]/palette-footer:hidden");
    const wrapper = container.firstChild as HTMLElement;
    expect(wrapper.className).toContain("@container/palette-footer");
  });
});
