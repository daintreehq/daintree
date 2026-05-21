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

  describe("isStale (deferred filter)", () => {
    it("exposes isStale on the return object", () => {
      const { result } = renderHook(() =>
        useSearchablePalette<PaletteItem>({
          items: [{ id: "a", name: "A" }],
        })
      );

      // JSDOM resolves useDeferredValue synchronously inside act(), so the
      // observable steady-state value is always false. The contract we're
      // asserting here is structural: the field exists and is a boolean.
      expect(typeof result.current.isStale).toBe("boolean");
      expect(result.current.isStale).toBe(false);
    });

    it("filters by the deferred query (results stay consistent post-set)", () => {
      const items: PaletteItem[] = [
        { id: "alpha", name: "Alpha" },
        { id: "beta", name: "Beta" },
      ];

      const { result } = renderHook(() =>
        useSearchablePalette<PaletteItem>({
          items,
          filterFn: (allItems, query) => {
            if (!query) return allItems;
            return allItems.filter((item) => item.name.toLowerCase().includes(query.toLowerCase()));
          },
        })
      );

      act(() => {
        result.current.setQuery("alp");
      });

      // After the act() flush, the deferred render has caught up to the urgent
      // state — results reflect the typed query and isStale settles to false.
      expect(result.current.results.map((i) => i.id)).toEqual(["alpha"]);
      expect(result.current.isStale).toBe(false);
    });
  });

  describe("selection follow on filter narrow", () => {
    const filterByName = (allItems: PaletteItem[], query: string) => {
      if (!query) return allItems;
      const q = query.toLowerCase();
      return allItems.filter((item) => item.name.toLowerCase().includes(q));
    };

    it("follows the previously selected item to its new index when it's still present", () => {
      const items: PaletteItem[] = [
        { id: "alpha", name: "Alpha" },
        { id: "beta", name: "Beta" },
        { id: "bravo", name: "Bravo" },
        { id: "charlie", name: "Charlie" },
      ];

      const { result } = renderHook(() =>
        useSearchablePalette<PaletteItem>({ items, filterFn: filterByName })
      );

      // User arrows down to "Bravo" at index 2.
      act(() => {
        result.current.setSelectedIndex(2);
      });
      expect(result.current.results[result.current.selectedIndex]?.id).toBe("bravo");

      // User types "b" — list narrows to Beta + Bravo. Selection should follow
      // Bravo to its new index (1), not snap to first navigable (0 = Beta).
      act(() => {
        result.current.setQuery("b");
      });
      expect(result.current.results.map((i) => i.id)).toEqual(["beta", "bravo"]);
      expect(result.current.selectedIndex).toBe(1);
      expect(result.current.results[result.current.selectedIndex]?.id).toBe("bravo");
    });

    it("follows the previously selected item when the stale index stays in bounds (regression for in-bounds case)", () => {
      // Edge case: filter removes items BEFORE the selected item, so the stale
      // selectedIndex still lands inside the new results array but at a
      // different item. An effect-based ref observer would write the wrong
      // item ID here. Verifies the imperative-capture fix.
      const items: PaletteItem[] = [
        { id: "alpha", name: "Alpha" },
        { id: "beta", name: "Beta" },
        { id: "bravo", name: "Bravo" },
      ];

      const { result } = renderHook(() =>
        useSearchablePalette<PaletteItem>({ items, filterFn: filterByName })
      );

      // User selects "Beta" at index 1.
      act(() => {
        result.current.setSelectedIndex(1);
      });
      expect(result.current.results[result.current.selectedIndex]?.id).toBe("beta");

      // User types "b" — Alpha drops out. Results: [Beta, Bravo].
      // selectedIndex=1 stays in bounds but now points at Bravo. Follow must
      // chase the user-selected Beta (now index 0), not blindly accept Bravo.
      act(() => {
        result.current.setQuery("b");
      });
      expect(result.current.results.map((i) => i.id)).toEqual(["beta", "bravo"]);
      expect(result.current.selectedIndex).toBe(0);
      expect(result.current.results[result.current.selectedIndex]?.id).toBe("beta");
    });

    it("falls back to first navigable when the previously selected item is filtered out", () => {
      const items: PaletteItem[] = [
        { id: "alpha", name: "Alpha" },
        { id: "beta", name: "Beta" },
        { id: "charlie", name: "Charlie" },
      ];

      const { result } = renderHook(() =>
        useSearchablePalette<PaletteItem>({ items, filterFn: filterByName })
      );

      // User selects "Charlie" at index 2.
      act(() => {
        result.current.setSelectedIndex(2);
      });
      expect(result.current.results[result.current.selectedIndex]?.id).toBe("charlie");

      // User types "b" — Charlie is filtered out. Should fall back to index 0.
      act(() => {
        result.current.setQuery("b");
      });
      expect(result.current.results.map((i) => i.id)).toEqual(["beta"]);
      expect(result.current.selectedIndex).toBe(0);
    });

    it("falls back to first navigable when the followed item fails canNavigate", () => {
      // Initially all items are navigable; the user picks "Charlie", then a
      // narrowing query changes the list AND Charlie's enabled state. The
      // follow logic should reject the disabled Charlie and snap to the first
      // navigable item in the narrowed list (Alpha).
      const baseItems: PaletteItem[] = [
        { id: "alpha", name: "Alpha", disabled: false },
        { id: "beta", name: "Beta", disabled: false },
        { id: "gamma", name: "Gamma", disabled: false },
        { id: "charlie", name: "Charlie", disabled: false },
      ];

      const { result, rerender } = renderHook(
        (props: { items: PaletteItem[] }) =>
          useSearchablePalette<PaletteItem>({
            items: props.items,
            canNavigate: (item) => !item.disabled,
            filterFn: filterByName,
          }),
        { initialProps: { items: baseItems } }
      );

      // User selects "Charlie" at index 3.
      act(() => {
        result.current.setSelectedIndex(3);
      });
      expect(result.current.results[result.current.selectedIndex]?.id).toBe("charlie");

      // Flip Charlie to disabled in a new items array, then narrow with "l"
      // which matches only Alpha and Charlie.
      const itemsWithCharlieDisabled = baseItems.map((item) =>
        item.id === "charlie" ? { ...item, disabled: true } : item
      );
      act(() => {
        rerender({ items: itemsWithCharlieDisabled });
      });
      act(() => {
        result.current.setQuery("l");
      });

      expect(result.current.results.map((i) => i.id)).toEqual(["alpha", "charlie"]);
      // Charlie is present at index 1 but now non-navigable. Follow path
      // should reject it and snap to Alpha (the first navigable).
      expect(result.current.selectedIndex).toBe(0);
      expect(result.current.results[result.current.selectedIndex]?.id).toBe("alpha");
    });

    it("does not move selection when results are unchanged (fingerprint stable)", () => {
      const items: PaletteItem[] = [
        { id: "a", name: "Alpha" },
        { id: "b", name: "Beta" },
        { id: "c", name: "Charlie" },
      ];

      const { result, rerender } = renderHook(
        (props: { items: PaletteItem[] }) =>
          useSearchablePalette<PaletteItem>({ items: props.items }),
        { initialProps: { items } }
      );

      act(() => {
        result.current.setSelectedIndex(2);
      });
      expect(result.current.selectedIndex).toBe(2);

      // Same items, different array reference: fingerprint should match → no reset.
      rerender({ items: [...items] });
      expect(result.current.selectedIndex).toBe(2);
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
