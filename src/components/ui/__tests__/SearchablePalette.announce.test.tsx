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

const announceMock = vi.hoisted(() => vi.fn());
vi.mock("@/store/accessibilityAnnouncerStore", () => {
  // Match the real Zustand hook shape: callable selector + static `getState`,
  // plus the named `isDelivered`/`markDelivered` helpers that
  // `AccessibilityAnnouncer` imports alongside the hook.
  const state = { polite: null, assertive: null, nextId: 1, announce: announceMock };
  const useAnnouncerStore = Object.assign(
    (selector?: (s: typeof state) => unknown) => (selector ? selector(state) : state),
    {
      getState: () => state,
      setState: () => {},
      subscribe: () => () => {},
    }
  );
  return {
    useAnnouncerStore,
    isDelivered: () => false,
    markDelivered: () => {},
    _resetAnnouncerDeliveryForTests: () => {},
  };
});

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
    tier: "command" as const,
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
        tier="command"
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
        tier="command"
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
        tier="command"
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
        tier="command"
        isFiltering={isFiltering}
      />
    );

    rerender(renderProps(false, "x"));
    vi.advanceTimersByTime(100);
    rerender(renderProps(true, "xy"));
    vi.advanceTimersByTime(500);

    expect(announceMock).not.toHaveBeenCalled();
  });

  it("leaves a zero-result pass to the empty state's own announcement", () => {
    const { rerender } = renderPalette({ query: "zz", results: [], isFiltering: true });
    rerender(
      <SearchablePalette<Item>
        isOpen
        query="zz"
        results={[]}
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
        isFiltering={false}
      />
    );
    vi.advanceTimersByTime(400);
    expect(announceMock).not.toHaveBeenCalled();
  });

  it("still announces a zero count for a custom body, which draws no empty state", () => {
    const body = () => <div />;
    const { rerender } = render(
      <SearchablePalette<Item>
        isOpen
        query="zz"
        results={[]}
        selectedIndex={0}
        onQueryChange={() => {}}
        onSelectPrevious={() => {}}
        onSelectNext={() => {}}
        onConfirm={() => {}}
        onClose={() => {}}
        getItemId={(item) => item.id}
        renderItem={(item) => <div key={item.id}>{item.id}</div>}
        renderBody={body}
        label="Test"
        ariaLabel="Test palette"
        tier="command"
        isFiltering
      />
    );
    rerender(
      <SearchablePalette<Item>
        isOpen
        query="zz"
        results={[]}
        selectedIndex={0}
        onQueryChange={() => {}}
        onSelectPrevious={() => {}}
        onSelectNext={() => {}}
        onConfirm={() => {}}
        onClose={() => {}}
        getItemId={(item) => item.id}
        renderItem={(item) => <div key={item.id}>{item.id}</div>}
        renderBody={body}
        label="Test"
        ariaLabel="Test palette"
        tier="command"
        isFiltering={false}
      />
    );
    vi.advanceTimersByTime(400);
    expect(announceMock).toHaveBeenCalledWith("0 results", "polite");
  });
});

describe("SearchablePalette loading announcement", () => {
  const base = {
    isOpen: true,
    query: "",
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
    tier: "command" as const,
  };

  beforeEach(() => {
    vi.useFakeTimers();
    announceMock.mockClear();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("says nothing for a load that lands inside the gate", () => {
    const { rerender } = render(<SearchablePalette<Item> {...base} results={[]} isLoading />);
    vi.advanceTimersByTime(200);
    rerender(<SearchablePalette<Item> {...base} results={[{ id: "a" }]} isLoading={false} />);
    vi.advanceTimersByTime(1000);
    expect(announceMock).not.toHaveBeenCalled();
  });

  it("announces a slow load, then what it brought", () => {
    const { rerender } = render(<SearchablePalette<Item> {...base} results={[]} isLoading />);
    vi.advanceTimersByTime(400);
    expect(announceMock).toHaveBeenCalledTimes(1);
    rerender(
      <SearchablePalette<Item> {...base} results={[{ id: "a" }, { id: "b" }]} isLoading={false} />
    );
    vi.advanceTimersByTime(400);
    expect(announceMock).toHaveBeenCalledTimes(2);
    expect(announceMock).toHaveBeenLastCalledWith("2 results", "polite");
  });

  it("leaves an empty landing to the empty state", () => {
    const { rerender } = render(<SearchablePalette<Item> {...base} results={[]} isLoading />);
    vi.advanceTimersByTime(400);
    rerender(<SearchablePalette<Item> {...base} results={[]} isLoading={false} />);
    vi.advanceTimersByTime(1000);
    expect(announceMock).toHaveBeenCalledTimes(1);
  });

  it("does not restart the loading announcement when rows arrive mid-load", () => {
    const { rerender } = render(<SearchablePalette<Item> {...base} results={[]} isLoading />);
    vi.advanceTimersByTime(300);
    rerender(<SearchablePalette<Item> {...base} results={[{ id: "a" }]} isLoading />);
    vi.advanceTimersByTime(150);
    expect(announceMock).toHaveBeenCalledTimes(1);
    rerender(<SearchablePalette<Item> {...base} results={[{ id: "a" }, { id: "b" }]} isLoading />);
    vi.advanceTimersByTime(1000);
    expect(announceMock).toHaveBeenCalledTimes(1);
  });

  it("speaks one count when a load and a filter pass settle together", () => {
    const { rerender } = render(
      <SearchablePalette<Item> {...base} query="a" results={[]} isLoading isFiltering />
    );
    vi.advanceTimersByTime(400);
    announceMock.mockClear();
    rerender(
      <SearchablePalette<Item>
        {...base}
        query="a"
        results={[{ id: "a" }]}
        isLoading={false}
        isFiltering={false}
      />
    );
    vi.advanceTimersByTime(1000);
    expect(announceMock).toHaveBeenCalledTimes(1);
    expect(announceMock).toHaveBeenCalledWith("1 result", "polite");
  });
});
