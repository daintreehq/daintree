// @vitest-environment jsdom
import { useLayoutEffect } from "react";
import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { IFuseOptions } from "fuse.js";
import type { PaletteId } from "@/store/paletteStore";

const fuseCalls = vi.hoisted(() => ({ built: 0, searched: 0 }));

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

const { usePaletteStore } = await import("@/store/paletteStore");
const { useSearchablePalette } = await import("../useSearchablePalette");
type FuseResultMatch = import("../useSearchablePalette").FuseResultMatch;

interface Row {
  id: string;
  name: string;
}

const OPTIONS: IFuseOptions<Row> = { keys: ["name"], threshold: 0.4 };
const makeRows = (): Row[] =>
  ["alpha", "alpine", "beta", "gamma", "delta"].map((name) => ({ id: name, name }));

function renderPanelPalette(initialItems = makeRows()) {
  return renderHook(
    ({ items }: { items: Row[] }) =>
      useSearchablePalette<Row>({
        items,
        fuseOptions: OPTIONS,
        paletteId: "panel",
        resetOnStoreOpen: true,
      }),
    { initialProps: { items: initialItems } }
  );
}

const openFromOutside = (id: PaletteId) => act(() => usePaletteStore.getState().openPalette(id));

describe("useSearchablePalette search work", () => {
  beforeEach(() => {
    fuseCalls.built = 0;
    fuseCalls.searched = 0;
    usePaletteStore.setState({ activePaletteId: null });
  });

  afterEach(() => {
    usePaletteStore.setState({ activePaletteId: null });
  });

  it("indexes nothing while closed or browsing, then once for the first query, and searches once per query", () => {
    const { result, rerender } = renderPanelPalette();
    rerender({ items: makeRows() });
    expect(fuseCalls).toEqual({ built: 0, searched: 0 });

    openFromOutside("panel");
    expect(result.current.results).toHaveLength(5);
    expect(fuseCalls).toEqual({ built: 0, searched: 0 });

    act(() => result.current.setQuery("alp"));
    expect(result.current.results.map((r) => r.id).sort()).toEqual(["alpha", "alpine"]);
    expect(fuseCalls).toEqual({ built: 1, searched: 1 });

    act(() => result.current.selectNext());
    act(() => result.current.setQuery("alph"));
    expect(result.current.results.map((r) => r.id)).toContain("alpha");
    expect(fuseCalls).toEqual({ built: 1, searched: 2 });
  });

  it("does not search behind a palette another one took over, even with its query left in place", () => {
    const { result, rerender } = renderPanelPalette();
    openFromOutside("panel");
    act(() => result.current.setQuery("alp"));
    expect(fuseCalls).toEqual({ built: 1, searched: 1 });

    openFromOutside("action");
    expect(result.current.isOpen).toBe(false);
    rerender({ items: makeRows() });
    expect(fuseCalls).toEqual({ built: 1, searched: 1 });
  });

  it("gives a store open the same fresh start as open(), including a palette left mid-search", () => {
    const { result } = renderPanelPalette();
    openFromOutside("panel");
    // A hit that sits below the top of the browse list: following it there
    // instead of starting over would land the reopened palette on row 2.
    act(() => result.current.setQuery("bet"));
    expect(result.current.results.map((r) => r.id)).toEqual(["beta"]);

    openFromOutside("action");
    openFromOutside("panel");
    expect(result.current.query).toBe("");
    expect(result.current.results).toHaveLength(5);
    expect(result.current.selectedIndex).toBe(0);
  });

  it("reopens a deferred palette on its browse rows, never the last opening's search", () => {
    // Over the deferral threshold, so filtering trails the input by a render.
    const items: Row[] = Array.from({ length: 400 }, (_, i) => {
      const name = i === 5 ? "zebra" : `item ${String(i).padStart(3, "0")}`;
      return { id: name, name };
    });
    const committedWhileOpen: string[] = [];
    const { result } = renderHook(() => {
      const palette = useSearchablePalette<Row>({
        items,
        fuseOptions: OPTIONS,
        paletteId: "panel",
        resetOnStoreOpen: true,
      });
      useLayoutEffect(() => {
        if (palette.isOpen) committedWhileOpen.push(palette.results[0]?.id ?? "");
      });
      return palette;
    });
    openFromOutside("panel");
    act(() => result.current.setQuery("zebra"));
    expect(result.current.results.map((r) => r.id)).toEqual(["zebra"]);

    openFromOutside("action");
    committedWhileOpen.length = 0;
    openFromOutside("panel");

    expect(result.current.query).toBe("");
    expect(committedWhileOpen.length).toBeGreaterThan(0);
    expect(committedWhileOpen.every((id) => id === "item 000")).toBe(true);
    expect(result.current.selectedIndex).toBe(0);
  });

  it("leaves a palette that didn't ask for store resets as its own opener left it", () => {
    const { result } = renderHook(() =>
      useSearchablePalette<Row>({ items: makeRows(), fuseOptions: OPTIONS, paletteId: "theme" })
    );
    openFromOutside("theme");
    act(() => result.current.setQuery("bet"));
    openFromOutside("theme");
    expect(result.current.query).toBe("bet");
  });

  it("starts over when the palette that is already open is asked to open again", () => {
    const { result, rerender } = renderPanelPalette();
    openFromOutside("panel");
    act(() => result.current.setQuery("bet"));
    rerender({ items: makeRows() });
    expect(result.current.query).toBe("bet");

    openFromOutside("panel");
    expect(result.current.query).toBe("");
  });

  it("starts a palette that opens on its first render with no reset to undo", () => {
    usePaletteStore.getState().openPalette("panel");
    const { result } = renderPanelPalette();
    expect(result.current.isOpen).toBe(true);
    act(() => result.current.setQuery("gam"));
    expect(result.current.query).toBe("gam");
  });

  it("keeps one setter across result changes, which selects from the current rows", () => {
    const startsWith = (items: Row[], query: string) =>
      items.filter((item) => item.name.startsWith(query));
    const items = ["beta", "alpha", "alpine", "amber"].map((name) => ({ id: name, name }));
    const { result } = renderHook(() => useSearchablePalette<Row>({ items, filterFn: startsWith }));
    const setter = result.current.setSelectedIndex;

    act(() => result.current.setQuery("al"));
    expect(result.current.results.map((r) => r.id)).toEqual(["alpha", "alpine"]);
    expect(result.current.setSelectedIndex).toBe(setter);

    // Row 1 is "alpine" now but was "alpha" in the list the setter first saw.
    // Widening the query moves both, and the selection follows whichever row
    // the setter anchored.
    act(() => setter(1));
    act(() => result.current.setQuery("a"));
    expect(result.current.results.map((r) => r.id)).toEqual(["alpha", "alpine", "amber"]);
    expect(result.current.selectedIndex).toBe(1);
  });

  it("takes rows and match ranges from one searchFn pass", () => {
    const items = makeRows();
    const matches = new Map<string, readonly FuseResultMatch[]>([
      ["beta", [{ key: "name", value: "beta", indices: [[0, 1]] }]],
    ]);
    const searchFn = vi.fn((all: Row[], query: string) => ({
      items: query ? all.filter((item) => item.id === "beta") : all,
      matchesById: query ? matches : new Map<string, readonly FuseResultMatch[]>(),
    }));
    const filterFn = vi.fn((all: Row[]) => all);
    const { result } = renderHook(() =>
      useSearchablePalette<Row>({ items, searchFn, filterFn, fuseOptions: OPTIONS })
    );
    searchFn.mockClear();

    act(() => result.current.setQuery("be"));
    expect(result.current.results.map((r) => r.id)).toEqual(["beta"]);
    expect(result.current.matchesById).toBe(matches);
    expect(searchFn).toHaveBeenCalledTimes(1);
    expect(searchFn).toHaveBeenCalledWith(items, "be");
    expect(filterFn).not.toHaveBeenCalled();
    expect(fuseCalls.built).toBe(0);
  });
});
