// @vitest-environment jsdom
import { render, fireEvent } from "@testing-library/react";
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

const { escapeStackMock } = vi.hoisted(() => ({
  escapeStackMock: vi.fn(),
}));

vi.mock("@/lib/utils", () => ({
  cn: (...args: unknown[]) => args.filter(Boolean).join(" "),
}));

vi.mock("@/hooks", () => ({
  useEscapeStack: escapeStackMock,
  useOverlayState: () => {},
}));

vi.mock("@/hooks/useKeybinding", () => ({
  useEffectiveCombo: () => "⌘T",
}));

vi.mock("@/store/paletteStore", () => ({
  usePaletteStore: { getState: () => ({ activePaletteId: null }) },
}));

import { NewTerminalPalette } from "../NewTerminalPalette";
import type { LaunchOption } from "../launchOptions";

function makeOption(id: string): LaunchOption {
  return {
    id,
    label: `Option ${id}`,
    description: `Description for ${id}`,
    icon: null,
  };
}

function renderPalette(overrides: Partial<Parameters<typeof NewTerminalPalette>[0]> = {}) {
  const props = {
    isOpen: true,
    query: "",
    results: [makeOption("a"), makeOption("b"), makeOption("c")],
    selectedIndex: 0,
    onQueryChange: vi.fn(),
    onSelectPrevious: vi.fn(),
    onSelectNext: vi.fn(),
    onSelect: vi.fn(),
    onConfirm: vi.fn(),
    onClose: vi.fn(),
    ...overrides,
  };
  return { ...render(<NewTerminalPalette {...props} />), props };
}

describe("NewTerminalPalette", () => {
  it("renders terminal types in the listbox", () => {
    const { getByRole } = renderPalette();
    const listbox = getByRole("listbox", { name: "Terminal types" });
    expect(listbox.children.length).toBe(3);
  });

  it("renders empty state via AppPaletteDialog.Empty when query has no matches", () => {
    const { getByText } = renderPalette({ results: [], query: "zzz" });
    expect(getByText('No matches for "zzz"')).toBeTruthy();
  });

  it("renders empty state with default message when query is empty", () => {
    const { getByText } = renderPalette({ results: [], query: "" });
    expect(getByText("No items available")).toBeTruthy();
  });

  it("does not have aria-haspopup on the combobox input", () => {
    const { getByRole } = renderPalette();
    const combobox = getByRole("combobox");
    expect(combobox.hasAttribute("aria-haspopup")).toBe(false);
  });

  it("has a live region announcing result count", () => {
    const { getByText } = renderPalette();
    expect(getByText("3 terminal types")).toBeTruthy();
  });

  it("announces zero terminal types when results are empty", () => {
    const { getByText } = renderPalette({ results: [], query: "zzz" });
    expect(getByText("0 terminal types")).toBeTruthy();
  });

  it("calls useEscapeStack with clear-then-close handler", () => {
    escapeStackMock.mockClear();
    const onQueryChange = vi.fn();
    const onClose = vi.fn();
    renderPalette({ onQueryChange, onClose, query: "gemini" });

    const calls = escapeStackMock.mock.calls.filter((call: unknown[]) => call[0]);
    expect(calls.length).toBeGreaterThan(0);

    const handler = calls[0]![1] as () => void;
    handler();
    expect(onQueryChange).toHaveBeenCalledWith("");
    expect(onClose).not.toHaveBeenCalled();
  });

  it("useEscapeStack handler closes when query is empty", () => {
    escapeStackMock.mockClear();
    const onQueryChange = vi.fn();
    const onClose = vi.fn();
    renderPalette({ onQueryChange, onClose, query: "" });

    const calls = escapeStackMock.mock.calls.filter((call: unknown[]) => call[0]);
    expect(calls.length).toBeGreaterThan(0);

    const handler = calls[0]![1] as () => void;
    handler();
    expect(onQueryChange).not.toHaveBeenCalled();
    expect(onClose).toHaveBeenCalled();
  });
});

describe("NewTerminalPalette results region (#11431)", () => {
  it("forwards navigation from the region and resolves its active option", () => {
    const { getByRole, props } = renderPalette();
    const region = getByRole("group", { name: "Terminal types" });

    fireEvent.keyDown(region, { key: "ArrowDown" });
    fireEvent.keyDown(region, { key: "Enter" });

    expect(props.onSelectNext).toHaveBeenCalledTimes(1);
    expect(props.onConfirm).toHaveBeenCalledTimes(1);

    // A wrong id prefix here would silently break the announcement.
    const activeDescendant = region.getAttribute("aria-activedescendant");
    expect(activeDescendant).toBe("new-terminal-option-a");
    expect(document.getElementById(activeDescendant!)).not.toBeNull();
  });

  it("omits the active descendant when there are no results", () => {
    const { getByRole } = renderPalette({ results: [], selectedIndex: -1 });

    expect(
      getByRole("group", { name: "Terminal types" }).hasAttribute("aria-activedescendant")
    ).toBe(false);
  });
});
