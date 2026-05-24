// @vitest-environment jsdom
import { render } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

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

const announceMock = vi.fn();
vi.mock("@/store/accessibilityAnnouncerStore", () => ({
  useAnnouncerStore: { getState: () => ({ announce: announceMock }) },
}));

import { SearchablePalette } from "../SearchablePalette";

interface Item {
  id: string;
}

function renderPalette(initial: { query: string; results: Item[]; isFiltering: boolean }) {
  const props = {
    isOpen: true,
    query: initial.query,
    results: initial.results,
    selectedIndex: 0,
    onQueryChange: () => {},
    onSelectPrevious: () => {},
    onSelectNext: () => {},
    onConfirm: () => {},
    onClose: () => {},
    getItemId: (item: Item) => item.id,
    renderItem: (item: Item) => <div key={item.id}>{item.id}</div>,
    label: "Test",
    ariaLabel: "Test palette",
    isFiltering: initial.isFiltering,
  };
  return render(<SearchablePalette<Item> {...props} />);
}

describe("SearchablePalette filter-result live announcement", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    announceMock.mockClear();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("announces the result count after isFiltering transitions to false", () => {
    const items = [{ id: "a" }, { id: "b" }, { id: "c" }];
    const { rerender } = renderPalette({ query: "x", results: items, isFiltering: true });

    rerender(
      <SearchablePalette<Item>
        isOpen
        query="x"
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
        isFiltering={false}
      />
    );

    expect(announceMock).not.toHaveBeenCalled();
    vi.advanceTimersByTime(400);
    expect(announceMock).toHaveBeenCalledTimes(1);
    expect(announceMock).toHaveBeenCalledWith("3 results", "polite");
  });

  it("uses singular phrasing for exactly one result", () => {
    const items = [{ id: "a" }];
    const { rerender } = renderPalette({ query: "x", results: items, isFiltering: true });

    rerender(
      <SearchablePalette<Item>
        isOpen
        query="x"
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
        isFiltering={false}
      />
    );

    vi.advanceTimersByTime(400);
    expect(announceMock).toHaveBeenCalledWith("1 result", "polite");
  });

  it("skips the announcement when the query is empty", () => {
    const items = [{ id: "a" }];
    const { rerender } = renderPalette({ query: "", results: items, isFiltering: true });

    rerender(
      <SearchablePalette<Item>
        isOpen
        query=""
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
        isFiltering={false}
      />
    );

    vi.advanceTimersByTime(400);
    expect(announceMock).not.toHaveBeenCalled();
  });

  it("cancels the pending announcement if isFiltering flips back to true", () => {
    const items = [{ id: "a" }, { id: "b" }];
    const { rerender } = renderPalette({ query: "x", results: items, isFiltering: true });

    const renderProps = (isFiltering: boolean, query: string) => (
      <SearchablePalette<Item>
        isOpen
        query={query}
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
        isFiltering={isFiltering}
      />
    );

    rerender(renderProps(false, "x"));
    vi.advanceTimersByTime(100);
    rerender(renderProps(true, "xy"));
    vi.advanceTimersByTime(500);

    expect(announceMock).not.toHaveBeenCalled();
  });
});
