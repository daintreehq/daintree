// @vitest-environment jsdom
import { render, screen, fireEvent } from "@testing-library/react";
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
      { keys: ["↑", "↓"], label: "to navigate" },
      { keys: ["↵"], label: "to create" },
      { keys: ["Esc"], label: "to close" },
    ],
  };

  it("renders primary hint inline", () => {
    render(<PaletteFooterHints {...defaultProps} />);
    expect(screen.getByText("to create")).toBeTruthy();
    expect(screen.getByText("↵")).toBeTruthy();
  });

  it("renders CircleHelp button with correct aria-label", () => {
    render(<PaletteFooterHints {...defaultProps} />);
    const helpButton = screen.getByRole("button", { name: "Keyboard shortcuts" });
    expect(helpButton).toBeTruthy();
  });

  it("does not show popover hints initially", () => {
    render(<PaletteFooterHints {...defaultProps} />);
    expect(screen.queryByText("to navigate")).toBeNull();
  });

  it("shows all hints in popover on click", async () => {
    render(<PaletteFooterHints {...defaultProps} />);

    const helpButton = screen.getByRole("button", { name: "Keyboard shortcuts" });
    fireEvent.click(helpButton);

    expect(screen.getByText("to navigate")).toBeTruthy();
    expect(screen.getByText("to close")).toBeTruthy();
  });

  it("renders multiple keys for a hint", () => {
    render(
      <PaletteFooterHints
        primaryHint={{ keys: ["↑", "↓"], label: "to navigate" }}
        hints={[{ keys: ["↑", "↓"], label: "to navigate" }]}
      />
    );
    expect(screen.getByText("↑")).toBeTruthy();
    expect(screen.getByText("↓")).toBeTruthy();
  });
});
