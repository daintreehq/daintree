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

import { AppPaletteDialog } from "../AppPaletteDialog";

describe("AppPaletteDialog.Empty", () => {
  it("renders children when query is empty (no-data state)", () => {
    render(
      <AppPaletteDialog.Empty query="" emptyMessage="No items available">
        <span data-testid="cta">Create a terminal</span>
      </AppPaletteDialog.Empty>
    );
    expect(screen.getByTestId("cta")).toBeTruthy();
    expect(screen.getByText("No items available")).toBeTruthy();
  });

  it("renders children when query is whitespace only", () => {
    render(
      <AppPaletteDialog.Empty query="   " emptyMessage="No items available">
        <span data-testid="cta">Create a terminal</span>
      </AppPaletteDialog.Empty>
    );
    expect(screen.getByTestId("cta")).toBeTruthy();
  });

  it("does NOT render children when query has text (no-match state)", () => {
    render(
      <AppPaletteDialog.Empty query="foo" emptyMessage="No items available">
        <span data-testid="cta">Create a terminal</span>
      </AppPaletteDialog.Empty>
    );
    expect(screen.queryByTestId("cta")).toBeNull();
    expect(screen.getByText(/No items match "foo"/)).toBeTruthy();
  });

  it("renders without children when none provided", () => {
    render(<AppPaletteDialog.Empty query="" emptyMessage="No items available" />);
    expect(screen.getByText("No items available")).toBeTruthy();
  });

  it("shows noMatchMessage when query present and noMatchMessage provided", () => {
    render(
      <AppPaletteDialog.Empty
        query="xyz"
        emptyMessage="No items available"
        noMatchMessage="Nothing found"
      >
        <span data-testid="cta">hint</span>
      </AppPaletteDialog.Empty>
    );
    expect(screen.getByText("Nothing found")).toBeTruthy();
    expect(screen.queryByTestId("cta")).toBeNull();
  });
});
