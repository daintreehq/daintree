// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PanelInstance } from "@shared/types/panel";

const { fuseCalls, useWorktreeStoreMock } = vi.hoisted(() => ({
  fuseCalls: { built: 0, searched: 0 },
  useWorktreeStoreMock: vi.fn(),
}));

vi.mock("fuse.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("fuse.js")>();
  const Real = actual.default as unknown as new (...args: unknown[]) => {
    search: (...args: unknown[]) => unknown;
  };
  function CountingFuse(...args: unknown[]) {
    fuseCalls.built += 1;
    const fuse = new Real(...args);
    const search = fuse.search.bind(fuse);
    fuse.search = (...searchArgs: unknown[]) => {
      fuseCalls.searched += 1;
      return search(...searchArgs);
    };
    return fuse;
  }
  return { ...actual, default: CountingFuse };
});

vi.mock("@/hooks/useWorktreeStore", () => ({ useWorktreeStore: useWorktreeStoreMock }));

vi.mock("@/store", async () => {
  const actual = await vi.importActual<typeof import("@/store")>("@/store");
  return {
    ...actual,
    useWorktreeSelectionStore: Object.assign(
      (selector: (s: unknown) => unknown) =>
        selector({ selectWorktree: vi.fn(), activeWorktreeId: null }),
      { getState: () => ({ activeWorktreeId: null }) }
    ),
  };
});

const { usePanelStore } = await import("@/store/panelStore");
const { usePaletteStore } = await import("@/store/paletteStore");
const { useQuickSwitcher } = await import("../useQuickSwitcher");

function seedPanels(titles: string[]) {
  const panels = titles.map(
    (title, i) =>
      ({ id: `p-${i}`, kind: "browser", title, location: "grid" }) as unknown as PanelInstance
  );
  usePanelStore.setState({
    panelsById: Object.fromEntries(panels.map((panel) => [panel.id, panel])),
    panelIds: panels.map((panel) => panel.id),
    mruList: [],
  });
}

describe("useQuickSwitcher search work", () => {
  beforeEach(() => {
    fuseCalls.built = 0;
    fuseCalls.searched = 0;
    // One state object, as the real store hands back: a fresh Map per read
    // would rebuild the item list, and so the index, on every render.
    const worktreeState = {
      worktrees: new Map(),
      isLoading: false,
      isInitialized: true,
      isReconnecting: false,
      error: null,
    };
    useWorktreeStoreMock.mockImplementation((selector: (s: unknown) => unknown) =>
      selector(worktreeState)
    );
    seedPanels(["Claude agent", "build server", "docs preview"]);
    usePaletteStore.setState({ activePaletteId: null });
  });

  afterEach(() => {
    usePaletteStore.setState({ activePaletteId: null });
  });

  it("indexes nothing while closed, then ranks and highlights from one search per query", () => {
    const { result } = renderHook(() => useQuickSwitcher());
    expect(fuseCalls).toEqual({ built: 0, searched: 0 });

    act(() => usePaletteStore.getState().openPalette("quick-switcher"));
    expect(result.current.results).toHaveLength(3);
    expect(fuseCalls).toEqual({ built: 0, searched: 0 });

    act(() => result.current.setQuery("clau"));
    expect(result.current.results[0]!.id).toBe("terminal:p-0");
    const ranges = result.current.matchesById.get("terminal:p-0");
    expect(ranges?.[0]?.key).toBe("title");
    expect(ranges?.[0]?.indices).toEqual([[0, 3]]);
    expect(fuseCalls).toEqual({ built: 1, searched: 1 });

    act(() => result.current.selectNext());
    act(() => result.current.setQuery("claud"));
    expect(fuseCalls).toEqual({ built: 1, searched: 2 });
  });

  it("does no search work behind another palette, and reopens fresh", () => {
    const { result } = renderHook(() => useQuickSwitcher());
    act(() => usePaletteStore.getState().openPalette("quick-switcher"));
    act(() => result.current.setQuery("clau"));
    expect(fuseCalls).toEqual({ built: 1, searched: 1 });

    act(() => usePaletteStore.getState().openPalette("action"));
    expect(result.current.isOpen).toBe(false);
    expect(fuseCalls).toEqual({ built: 1, searched: 1 });

    act(() => usePaletteStore.getState().openPalette("quick-switcher"));
    expect(result.current.query).toBe("");
    expect(result.current.results).toHaveLength(3);
    expect(fuseCalls).toEqual({ built: 1, searched: 1 });
  });

  it("finds rows by a single letter without marking single-letter bands", () => {
    const { result } = renderHook(() => useQuickSwitcher());
    act(() => usePaletteStore.getState().openPalette("quick-switcher"));
    act(() => result.current.setQuery("b"));

    expect(result.current.results.map((r) => r.id)).toContain("terminal:p-1");
    expect(result.current.matchesById.has("terminal:p-1")).toBe(false);
  });
});
