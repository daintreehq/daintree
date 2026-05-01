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

const items: Item[] = [{ id: "a" }, { id: "b" }];

function renderPalette(isFiltering: boolean | undefined) {
  return render(
    <SearchablePalette<Item>
      isOpen
      query="a"
      results={items}
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
      listId="test-palette-list"
      isFiltering={isFiltering}
    />
  );
}

describe("SearchablePalette stale visual", () => {
  it("applies palette-results-stale to the listbox when isFiltering is true", () => {
    renderPalette(true);
    const listbox = screen.getByRole("listbox");
    expect(listbox.classList.contains("palette-results-stale")).toBe(true);
    expect(listbox.getAttribute("data-stale")).toBe("true");
  });

  it("omits the class when isFiltering is false", () => {
    renderPalette(false);
    const listbox = screen.getByRole("listbox");
    expect(listbox.classList.contains("palette-results-stale")).toBe(false);
    expect(listbox.getAttribute("data-stale")).toBeNull();
  });

  it("omits the class when isFiltering is undefined (default)", () => {
    renderPalette(undefined);
    const listbox = screen.getByRole("listbox");
    expect(listbox.classList.contains("palette-results-stale")).toBe(false);
  });
});
