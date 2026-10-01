// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/utils", () => ({
  cn: (...args: unknown[]) => args.filter(Boolean).join(" "),
}));

vi.mock("@/hooks", () => ({
  useOverlayState: () => {},
}));

vi.mock("@/store/paletteStore", () => ({
  usePaletteStore: { getState: () => ({ activePaletteId: null }) },
}));

import { PaletteFooterHints } from "../AppPaletteDialog";

describe("PaletteFooterHints", () => {
  const defaultProps = {
    primaryHint: { keys: ["↵"], label: "to create" },
    hints: [
      { keys: ["↑", "↓"], label: "navigate" },
      { keys: ["Esc"], label: "close" },
    ],
  };

  it("renders the primary hint inline", () => {
    render(<PaletteFooterHints {...defaultProps} />);
    expect(screen.getByText("to create")).toBeTruthy();
    expect(screen.getByText("↵")).toBeTruthy();
  });

  it("speaks glyph caps by key name and hides the glyphs themselves", () => {
    const { container } = render(<PaletteFooterHints {...defaultProps} />);
    for (const cap of container.querySelectorAll("kbd")) {
      expect(cap.getAttribute("aria-hidden")).toBe("true");
    }
    const spoken = [...container.querySelectorAll(".sr-only")].map((el) => el.textContent);
    // Each spoken name is words, never the glyph a screen reader would mangle.
    expect(spoken).toHaveLength(3);
    for (const text of spoken) expect(text).toMatch(/^[A-Za-z ]+$/);
    expect(spoken[1]).toContain("Up");
  });

  it("renders all secondary hints ambient — no popover, no help button", () => {
    render(<PaletteFooterHints {...defaultProps} />);
    expect(screen.getByText("navigate")).toBeTruthy();
    expect(screen.getByText("close")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /keyboard shortcuts/i })).toBeNull();
  });

  it("renders all keys for a multi-key hint", () => {
    render(<PaletteFooterHints primaryHint={{ keys: ["↑", "↓"], label: "navigate" }} hints={[]} />);
    expect(screen.getByText("↑")).toBeTruthy();
    expect(screen.getByText("↓")).toBeTruthy();
  });

  it("renders no secondary chips when hints is empty", () => {
    render(<PaletteFooterHints primaryHint={defaultProps.primaryHint} hints={[]} />);
    expect(screen.queryByText("navigate")).toBeNull();
    expect(screen.queryByText("close")).toBeNull();
  });

  it("applies width-priority drop classes — last hint hides earliest", () => {
    const { container } = render(<PaletteFooterHints {...defaultProps} />);
    const escChip = screen.getByText("close").parentElement;
    const navChip = screen.getByText("navigate").parentElement;
    // Esc is rightmost (index 1 of 2) → from-end index 0 → highest breakpoint.
    expect(escChip?.className).toContain("@max-[380px]/palette-footer:hidden");
    // ↑↓ is index 0 of 2 → from-end index 1 → lower breakpoint, hides only when narrower.
    expect(navChip?.className).toContain("@max-[280px]/palette-footer:hidden");
    // Sanity: container query named container is on the wrapper.
    const wrapper = container.firstChild as HTMLElement;
    expect(wrapper.className).toContain("@container/palette-footer");
  });
});
