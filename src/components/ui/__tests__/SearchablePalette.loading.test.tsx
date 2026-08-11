// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import { beforeAll, describe, expect, it, vi } from "vitest";

class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}

beforeAll(() => {
  if (typeof globalThis.ResizeObserver === "undefined") {
    globalThis.ResizeObserver = ResizeObserverStub as typeof ResizeObserver;
  }
});

vi.mock("@/lib/utils", () => ({
  cn: (...args: unknown[]) => args.filter(Boolean).join(" "),
}));

vi.mock("@/hooks", () => ({
  useEscapeStack: () => {},
  useOverlayState: () => {},
}));

vi.mock("@/store/paletteStore", () => ({
  usePaletteStore: { getState: () => ({ activePaletteId: null }) },
}));

import { SearchablePalette } from "../SearchablePalette";

interface Item {
  id: string;
}

function renderPalette({ isLoading, results }: { isLoading?: boolean; results: Item[] }) {
  return render(
    <SearchablePalette<Item>
      isOpen
      query=""
      results={results}
      selectedIndex={0}
      onQueryChange={() => {}}
      onSelectPrevious={() => {}}
      onSelectNext={() => {}}
      onConfirm={() => {}}
      onClose={() => {}}
      getItemId={(item) => item.id}
      renderItem={(item) => <div key={item.id}>{item.id}</div>}
      label="Test"
      ariaLabel="Test palette"
      tier="command"
      emptyMessage="No items available"
      isLoading={isLoading}
    />
  );
}

describe("SearchablePalette loading + empty state", () => {
  it("suppresses the empty state while isLoading is true and results are empty", () => {
    renderPalette({ isLoading: true, results: [] });
    expect(screen.queryByText("No items available")).toBeNull();
    // The header progress bar is the only loading affordance — assert it's
    // present and marked active so a screen reader doesn't get a misleading
    // empty-state announcement layered on top.
    const bar = document.querySelector<HTMLElement>(".palette-loading-bar");
    expect(bar?.dataset.loading).toBe("true");
  });

  it("shows the empty state when isLoading is false and results are empty", () => {
    renderPalette({ isLoading: false, results: [] });
    expect(screen.getByText("No items available")).toBeTruthy();
  });

  it("shows the empty state when isLoading is omitted (default false)", () => {
    renderPalette({ results: [] });
    expect(screen.getByText("No items available")).toBeTruthy();
  });

  it("renders the listbox normally when isLoading is true but results exist", () => {
    renderPalette({ isLoading: true, results: [{ id: "a" }] });
    expect(screen.getByRole("listbox")).toBeTruthy();
    expect(screen.queryByText("No items available")).toBeNull();
  });
});
