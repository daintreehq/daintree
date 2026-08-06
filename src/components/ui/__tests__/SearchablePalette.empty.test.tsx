// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
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
  label: string;
}

interface RenderArgs {
  query?: string;
  results?: Item[];
  emptyShortcut?: string | null;
  emptyEntityName?: string;
  emptyContent?: React.ReactNode;
}

function renderEmpty({
  query = "",
  results = [],
  emptyShortcut,
  emptyEntityName,
  emptyContent,
}: RenderArgs = {}) {
  return render(
    <SearchablePalette<Item>
      isOpen
      query={query}
      results={results}
      selectedIndex={-1}
      onQueryChange={() => {}}
      onSelectPrevious={() => {}}
      onSelectNext={() => {}}
      onConfirm={() => {}}
      onClose={() => {}}
      getItemId={(item) => item.id}
      renderItem={(item) => <div key={item.id}>{item.label}</div>}
      label="Test"
      ariaLabel="Test palette"
      tier="command"
      emptyShortcut={emptyShortcut}
      emptyEntityName={emptyEntityName}
      emptyContent={emptyContent}
    />
  );
}

describe("SearchablePalette empty-state chip", () => {
  it("auto-renders the chip when both emptyShortcut and emptyEntityName are set", () => {
    renderEmpty({ emptyShortcut: "⌘N", emptyEntityName: "a terminal" });
    expect(screen.getByText(/Press/)).toBeTruthy();
    expect(screen.getByText("⌘N")).toBeTruthy();
    expect(screen.getByText(/to create a terminal\./)).toBeTruthy();
  });

  it("renders the shortcut inside a kbd element", () => {
    renderEmpty({ emptyShortcut: "⌘N", emptyEntityName: "a terminal" });
    const kbd = screen.getByText("⌘N");
    expect(kbd.tagName).toBe("KBD");
  });

  it("does NOT render the chip when query is non-empty (no-match state)", () => {
    renderEmpty({
      query: "foo",
      emptyShortcut: "⌘N",
      emptyEntityName: "a terminal",
    });
    expect(screen.queryByText(/Press/)).toBeNull();
    expect(screen.queryByText("⌘N")).toBeNull();
  });

  it("does NOT render the chip when emptyShortcut is null (no keybinding bound)", () => {
    renderEmpty({ emptyShortcut: null, emptyEntityName: "a terminal" });
    expect(screen.queryByText(/Press/)).toBeNull();
  });

  it("does NOT render the chip when only emptyEntityName is provided", () => {
    renderEmpty({ emptyEntityName: "a terminal" });
    expect(screen.queryByText(/Press/)).toBeNull();
  });

  it("does NOT render the chip when only emptyShortcut is provided", () => {
    renderEmpty({ emptyShortcut: "⌘N" });
    expect(screen.queryByText(/Press/)).toBeNull();
  });

  it("explicit emptyContent takes precedence over the auto-chip", () => {
    renderEmpty({
      emptyShortcut: "⌘N",
      emptyEntityName: "a terminal",
      emptyContent: <span data-testid="custom-empty">Custom hint</span>,
    });
    expect(screen.getByTestId("custom-empty")).toBeTruthy();
    expect(screen.queryByText("⌘N")).toBeNull();
  });
});
