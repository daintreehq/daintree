// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { usePaletteStore } from "@/store/paletteStore";
import { useSearchablePalette } from "../useSearchablePalette";

interface PaletteItem {
  id: string;
  name: string;
  disabled?: boolean;
}

describe("useSearchablePalette", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    usePaletteStore.setState({ activePaletteId: null });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("keeps selection on first navigable item when opening palette", () => {
    const items: PaletteItem[] = [
      { id: "disabled-1", name: "Disabled", disabled: true },
      { id: "enabled-1", name: "Enabled", disabled: false },
    ];

    const { result } = renderHook(() =>
      useSearchablePalette<PaletteItem>({
        items,
        debounceMs: 0,
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
        debounceMs: 0,
        canNavigate: (item) => !item.disabled,
      })
    );

    expect(result.current.selectedIndex).toBe(-1);
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
