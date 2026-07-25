// @vitest-environment jsdom
import { render, screen, fireEvent } from "@testing-library/react";
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

function renderPalette(overrides: Record<string, unknown> = {}) {
  const props = {
    isOpen: true,
    query: "",
    results: items,
    selectedIndex: 0,
    onQueryChange: vi.fn(),
    onSelectPrevious: vi.fn(),
    onSelectNext: vi.fn(),
    onConfirm: vi.fn(),
    onClose: vi.fn(),
    getItemId: (item: Item) => item.id,
    renderItem: (item: Item) => <div key={item.id}>{item.id}</div>,
    label: "Test",
    ariaLabel: "Test palette",
    ...overrides,
  };
  return render(<SearchablePalette<Item> {...props} />);
}

/**
 * IME composition guard predicate — mirrors the canonical pattern from
 * `src/components/Terminal/__tests__/xtermCompositionGuard.test.ts`.
 */
function isComposing(event: { isComposing: boolean; nativeEvent: { keyCode: number } }): boolean {
  return event.isComposing || event.nativeEvent.keyCode === 229;
}

describe("SearchablePalette IME composition guard (predicate)", () => {
  describe("blocks keys during active composition", () => {
    it("returns true when isComposing is true", () => {
      expect(isComposing({ isComposing: true, nativeEvent: { keyCode: 13 } })).toBe(true);
    });

    it("returns true for keyCode 229 (Chromium Process key)", () => {
      expect(isComposing({ isComposing: false, nativeEvent: { keyCode: 229 } })).toBe(true);
    });

    it("returns true when both isComposing and keyCode 229", () => {
      expect(isComposing({ isComposing: true, nativeEvent: { keyCode: 229 } })).toBe(true);
    });
  });

  describe("allows keys when not composing", () => {
    it("returns false for plain Enter", () => {
      expect(isComposing({ isComposing: false, nativeEvent: { keyCode: 13 } })).toBe(false);
    });

    it("returns false for ArrowDown", () => {
      expect(isComposing({ isComposing: false, nativeEvent: { keyCode: 40 } })).toBe(false);
    });

    it("returns false for ArrowUp", () => {
      expect(isComposing({ isComposing: false, nativeEvent: { keyCode: 38 } })).toBe(false);
    });

    it("returns false for Tab", () => {
      expect(isComposing({ isComposing: false, nativeEvent: { keyCode: 9 } })).toBe(false);
    });
  });
});

describe("SearchablePalette keyboard navigation (non-composing)", () => {
  it("navigates down on ArrowDown", () => {
    const onSelectNext = vi.fn();
    renderPalette({ onSelectNext });
    const input = screen.getByRole("combobox");
    fireEvent.keyDown(input, { key: "ArrowDown", keyCode: 40 });
    expect(onSelectNext).toHaveBeenCalled();
  });

  it("navigates up on ArrowUp", () => {
    const onSelectPrevious = vi.fn();
    renderPalette({ onSelectPrevious });
    const input = screen.getByRole("combobox");
    fireEvent.keyDown(input, { key: "ArrowUp", keyCode: 38 });
    expect(onSelectPrevious).toHaveBeenCalled();
  });

  it("confirms on Enter", () => {
    const onConfirm = vi.fn();
    renderPalette({ onConfirm });
    const input = screen.getByRole("combobox");
    fireEvent.keyDown(input, { key: "Enter", keyCode: 13 });
    expect(onConfirm).toHaveBeenCalled();
  });

  it("does NOT call onConfirm when Enter fires during composition", () => {
    const onConfirm = vi.fn();
    renderPalette({ onConfirm, selectedIndex: 0 });
    const input = screen.getByRole("combobox");
    const event = new window.KeyboardEvent("keydown", {
      key: "Enter",
      keyCode: 13,
    });
    Object.defineProperty(event, "isComposing", { value: true });
    input.dispatchEvent(event);
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it("does NOT call onConfirm when keyCode 229 (Process key) fires", () => {
    const onConfirm = vi.fn();
    renderPalette({ onConfirm });
    const input = screen.getByRole("combobox");
    const event = new window.KeyboardEvent("keydown", {
      key: "Process",
      keyCode: 229,
    });
    input.dispatchEvent(event);
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it("jumps to the first row on Home", () => {
    const onHoverIndex = vi.fn();
    renderPalette({ onHoverIndex, selectedIndex: 1 });
    const input = screen.getByRole("combobox");
    fireEvent.keyDown(input, { key: "Home", keyCode: 36 });
    expect(onHoverIndex).toHaveBeenCalledWith(0);
  });

  it("jumps to the last row on End", () => {
    const onHoverIndex = vi.fn();
    renderPalette({ onHoverIndex, selectedIndex: 0 });
    const input = screen.getByRole("combobox");
    fireEvent.keyDown(input, { key: "End", keyCode: 35 });
    expect(onHoverIndex).toHaveBeenCalledWith(items.length - 1);
  });

  it("does not intercept Home when the result list is empty", () => {
    const onHoverIndex = vi.fn();
    renderPalette({ onHoverIndex, results: [] });
    const input = screen.getByRole("combobox");
    const event = new window.KeyboardEvent("keydown", { key: "Home", keyCode: 36, bubbles: true });
    let prevented = false;
    event.preventDefault = () => {
      prevented = true;
    };
    input.dispatchEvent(event);
    expect(onHoverIndex).not.toHaveBeenCalled();
    expect(prevented).toBe(false);
  });

  it("does not intercept End when the result list is empty", () => {
    const onHoverIndex = vi.fn();
    renderPalette({ onHoverIndex, results: [] });
    const input = screen.getByRole("combobox");
    const event = new window.KeyboardEvent("keydown", { key: "End", keyCode: 35, bubbles: true });
    let prevented = false;
    event.preventDefault = () => {
      prevented = true;
    };
    input.dispatchEvent(event);
    expect(onHoverIndex).not.toHaveBeenCalled();
    expect(prevented).toBe(false);
  });
});

describe("SearchablePalette Tab remap (input)", () => {
  it("moves the selection forward on Tab and cancels native traversal", () => {
    const onSelectNext = vi.fn();
    renderPalette({ onSelectNext });
    const notCancelled = fireEvent.keyDown(screen.getByRole("combobox"), { key: "Tab" });

    expect(onSelectNext).toHaveBeenCalledTimes(1);
    expect(notCancelled).toBe(false);
  });

  it("moves the selection backward on Shift+Tab and cancels native traversal", () => {
    const onSelectPrevious = vi.fn();
    renderPalette({ onSelectPrevious });
    const notCancelled = fireEvent.keyDown(screen.getByRole("combobox"), {
      key: "Tab",
      shiftKey: true,
    });

    expect(onSelectPrevious).toHaveBeenCalledTimes(1);
    expect(notCancelled).toBe(false);
  });

  it("lets the custom onKeyDown hook pre-empt the Tab remap", () => {
    const onSelectNext = vi.fn();
    const onKeyDown = vi.fn((e: React.KeyboardEvent) => e.preventDefault());
    renderPalette({ onSelectNext, onKeyDown });
    fireEvent.keyDown(screen.getByRole("combobox"), { key: "Tab" });

    expect(onKeyDown).toHaveBeenCalledTimes(1);
    expect(onSelectNext).not.toHaveBeenCalled();
  });
});

describe("SearchablePalette results region (#11431)", () => {
  function getRegion() {
    return screen.getByRole("group", { name: "Test" });
  }

  it("drives the same navigation as the input while it owns focus", () => {
    const onSelectNext = vi.fn();
    const onSelectPrevious = vi.fn();
    const onConfirm = vi.fn();
    renderPalette({ onSelectNext, onSelectPrevious, onConfirm });
    const region = getRegion();

    fireEvent.keyDown(region, { key: "ArrowDown" });
    fireEvent.keyDown(region, { key: "ArrowUp" });
    fireEvent.keyDown(region, { key: "Enter" });

    expect(onSelectNext).toHaveBeenCalledTimes(1);
    expect(onSelectPrevious).toHaveBeenCalledTimes(1);
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it("does not remap Tab on the region, so focus can leave the list", () => {
    const onSelectNext = vi.fn();
    renderPalette({ onSelectNext });
    const notCancelled = fireEvent.keyDown(getRegion(), { key: "Tab" });

    expect(onSelectNext).not.toHaveBeenCalled();
    expect(notCancelled).toBe(true);
  });

  it("omits the active descendant when there are no results", () => {
    renderPalette({ results: [], selectedIndex: -1 });

    expect(getRegion().hasAttribute("aria-activedescendant")).toBe(false);
  });
});
