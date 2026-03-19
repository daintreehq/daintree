// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import { usePaletteStore } from "@/store/paletteStore";
import { useSearchablePalette } from "../useSearchablePalette";

interface PaletteItem {
  id: string;
  name: string;
  disabled?: boolean;
}

describe("useSearchablePalette", () => {
  beforeEach(() => {
    usePaletteStore.setState({ activePaletteId: null });
  });

  it("keeps selection on first navigable item when opening palette", () => {
    const items: PaletteItem[] = [
      { id: "disabled-1", name: "Disabled", disabled: true },
      { id: "enabled-1", name: "Enabled", disabled: false },
    ];

    const { result } = renderHook(() =>
      useSearchablePalette<PaletteItem>({
        items,
        canNavigate: (item) => !item.disabled,
      })
    );

    expect(result.current.selectedIndex).toBe(1);

    act(() => {
      result.current.open();
    });

    expect(result.current.isOpen).toBe(true);
    expect(result.current.selectedIndex).toBe(1);
  });

  it("returns -1 selected index when no items are navigable", () => {
    const items: PaletteItem[] = [{ id: "disabled-only", name: "Disabled", disabled: true }];

    const { result } = renderHook(() =>
      useSearchablePalette<PaletteItem>({
        items,
        canNavigate: (item) => !item.disabled,
      })
    );

    expect(result.current.selectedIndex).toBe(-1);
  });

  it("exposes isStale as false when query matches deferred value", () => {
    const items: PaletteItem[] = [{ id: "a", name: "Alpha" }];

    const { result } = renderHook(() => useSearchablePalette<PaletteItem>({ items }));

    expect(result.current.isStale).toBe(false);

    act(() => {
      result.current.setQuery("test");
    });

    // In test environment, useDeferredValue resolves synchronously within act()
    expect(result.current.isStale).toBe(false);
  });

  describe("totalResults", () => {
    it("exposes total count before slicing when results exceed maxResults", () => {
      const items: PaletteItem[] = Array.from({ length: 25 }, (_, i) => ({
        id: `item-${i}`,
        name: `Item ${i}`,
      }));

      const { result } = renderHook(() =>
        useSearchablePalette<PaletteItem>({
          items,
          maxResults: 20,
        })
      );

      expect(result.current.results).toHaveLength(20);
      expect(result.current.totalResults).toBe(25);
    });

    it("totalResults equals results.length when not truncated", () => {
      const items: PaletteItem[] = Array.from({ length: 10 }, (_, i) => ({
        id: `item-${i}`,
        name: `Item ${i}`,
      }));

      const { result } = renderHook(() =>
        useSearchablePalette<PaletteItem>({
          items,
          maxResults: 20,
        })
      );

      expect(result.current.results).toHaveLength(10);
      expect(result.current.totalResults).toBe(10);
    });

    it("totalResults updates after query change narrows results", () => {
      const items: PaletteItem[] = [
        ...Array.from({ length: 25 }, (_, i) => ({
          id: `alpha-${i}`,
          name: `Alpha ${i}`,
        })),
        ...Array.from({ length: 5 }, (_, i) => ({
          id: `beta-${i}`,
          name: `Beta ${i}`,
        })),
      ];

      const { result } = renderHook(() =>
        useSearchablePalette<PaletteItem>({
          items,
          maxResults: 20,
          filterFn: (allItems, query) => {
            if (!query) return allItems;
            return allItems.filter((item) => item.name.toLowerCase().includes(query.toLowerCase()));
          },
        })
      );

      expect(result.current.totalResults).toBe(30);

      act(() => {
        result.current.setQuery("Beta");
      });

      expect(result.current.results).toHaveLength(5);
      expect(result.current.totalResults).toBe(5);
    });

    it("totalResults works with fuse search", () => {
      const items: PaletteItem[] = Array.from({ length: 25 }, (_, i) => ({
        id: `item-${i}`,
        name: `Searchable Item ${i}`,
      }));

      const { result } = renderHook(() =>
        useSearchablePalette<PaletteItem>({
          items,
          maxResults: 10,
          fuseOptions: {
            keys: ["name"],
            threshold: 0.4,
          },
        })
      );

      // No query: all items shown, capped at maxResults
      expect(result.current.results).toHaveLength(10);
      expect(result.current.totalResults).toBe(25);

      // Query that matches all items via fuse
      act(() => {
        result.current.setQuery("Searchable");
      });

      expect(result.current.totalResults).toBeGreaterThan(0);
      expect(result.current.results.length).toBeLessThanOrEqual(10);
    });
  });

  describe("mutual exclusion via paletteId", () => {
    const items: PaletteItem[] = [{ id: "a", name: "A" }];

    it("opening palette B closes palette A", () => {
      const { result: paletteA } = renderHook(() =>
        useSearchablePalette<PaletteItem>({ items, paletteId: "new-terminal" })
      );
      const { result: paletteB } = renderHook(() =>
        useSearchablePalette<PaletteItem>({ items, paletteId: "action" })
      );

      act(() => paletteA.current.open());
      expect(paletteA.current.isOpen).toBe(true);
      expect(paletteB.current.isOpen).toBe(false);

      act(() => paletteB.current.open());
      expect(paletteA.current.isOpen).toBe(false);
      expect(paletteB.current.isOpen).toBe(true);
    });

    it("stale close from palette A does not close palette B", () => {
      const { result: paletteA } = renderHook(() =>
        useSearchablePalette<PaletteItem>({ items, paletteId: "new-terminal" })
      );
      const { result: paletteB } = renderHook(() =>
        useSearchablePalette<PaletteItem>({ items, paletteId: "action" })
      );

      act(() => paletteA.current.open());
      act(() => paletteB.current.open());

      // Stale close from A should be a no-op
      act(() => paletteA.current.close());
      expect(paletteB.current.isOpen).toBe(true);
      expect(usePaletteStore.getState().activePaletteId).toBe("action");
    });
  });
});
