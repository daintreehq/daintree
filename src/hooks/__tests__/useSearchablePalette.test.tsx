// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useSearchablePalette } from "../useSearchablePalette";

interface PaletteItem {
  id: string;
  name: string;
  disabled?: boolean;
}

describe("useSearchablePalette", () => {
  beforeEach(() => {
    vi.useFakeTimers();
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
});
