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
    // The create chip belongs to the zero-data state; a no-match state names
    // the way back instead.
    expect(screen.queryByText(/to create/)).toBeNull();
    expect(screen.queryByText("⌘N")).toBeNull();
    expect(screen.getByText(/to clear the search/)).toBeTruthy();
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

describe("SearchablePalette combobox popup relationship", () => {
  function combobox() {
    return document.querySelector('[role="combobox"]')!;
  }

  it("never claims an expanded popup whose listbox is not in the tree", () => {
    renderEmpty();
    const controls = combobox().getAttribute("aria-controls");
    const expanded = combobox().getAttribute("aria-expanded") === "true";
    const controlled = controls ? document.getElementById(controls) : null;
    expect(expanded ? controlled !== null : true).toBe(true);
    expect(controls === null || controlled !== null).toBe(true);
  });

  it("controls the rendered listbox once there are rows", () => {
    renderEmpty({ results: [{ id: "a", label: "Alpha" }] });
    const controls = combobox().getAttribute("aria-controls");
    expect(combobox().getAttribute("aria-expanded")).toBe("true");
    expect(document.getElementById(controls!)?.getAttribute("role")).toBe("listbox");
  });
});

describe("SearchablePalette combobox relationship", () => {
  it("claims an expanded popup only while its listbox exists", () => {
    const { rerender } = renderEmpty({ query: "zzz", results: [] });
    const input = screen.getByRole("combobox");
    expect(screen.queryByRole("listbox")).toBeNull();
    expect(input.getAttribute("aria-expanded")).toBe("false");
    expect(input.getAttribute("aria-controls")).toBeNull();

    rerender(
      <SearchablePalette<Item>
        isOpen
        query="a"
        results={[{ id: "a", label: "Alpha" }]}
        selectedIndex={0}
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
      />
    );
    expect(input.getAttribute("aria-expanded")).toBe("true");
    const controls = input.getAttribute("aria-controls");
    expect(controls && document.getElementById(controls)?.getAttribute("role")).toBe("listbox");
  });
});

describe("SearchablePalette pointer focus", () => {
  it("keeps a press on the list's empty space from taking focus off the field", () => {
    renderEmpty({ query: "a", results: [{ id: "a", label: "Alpha" }] });
    const region = screen.getByRole("group", { name: "Test" });
    const notPrevented = region.dispatchEvent(
      new PointerEvent("pointerdown", { bubbles: true, cancelable: true })
    );
    expect(notPrevented).toBe(false);
  });
});
