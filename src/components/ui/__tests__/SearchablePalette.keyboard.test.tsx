// @vitest-environment jsdom
import { fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}

beforeAll(() => {
  if (typeof globalThis.ResizeObserver === "undefined") {
    globalThis.ResizeObserver = ResizeObserverStub as typeof ResizeObserver;
  }
  if (typeof Element.prototype.scrollIntoView !== "function") {
    Element.prototype.scrollIntoView = function scrollIntoView() {};
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

const announceMock = vi.hoisted(() => vi.fn());
vi.mock("@/store/accessibilityAnnouncerStore", () => {
  // Match the real Zustand hook shape: callable selector + static `getState`,
  // plus the named `isDelivered`/`markDelivered` helpers that
  // `AccessibilityAnnouncer` imports alongside the hook.
  const state = { polite: null, assertive: null, nextId: 1, announce: announceMock };
  const useAnnouncerStore = Object.assign(
    (selector?: (s: typeof state) => unknown) => (selector ? selector(state) : state),
    {
      getState: () => state,
      setState: () => {},
      subscribe: () => () => {},
    }
  );
  return {
    useAnnouncerStore,
    isDelivered: () => false,
    markDelivered: () => {},
    _resetAnnouncerDeliveryForTests: () => {},
  };
});

import { SearchablePalette } from "../SearchablePalette";
import type { PaletteSurfaceTier } from "../AppPaletteDialog";

interface Item {
  id: string;
  label?: string;
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
    tier: "command" as const,
    ...overrides,
  };
  return render(<SearchablePalette<Item> {...props} />);
}

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

  it("moves the cursor through onSelectIndex, not the hover handler, when both exist", () => {
    const onHoverIndex = vi.fn();
    const onSelectIndex = vi.fn();
    renderPalette({ onHoverIndex, onSelectIndex, selectedIndex: 0 });
    const input = screen.getByRole("combobox");
    fireEvent.keyDown(input, { key: "End", keyCode: 35 });
    expect(onSelectIndex).toHaveBeenCalledWith(items.length - 1);
    expect(onHoverIndex).not.toHaveBeenCalled();
  });

  it.each(["Home", "End"])(
    "leaves %s to the input when the consumer cannot move the cursor",
    (key) => {
      renderPalette({ selectedIndex: 1 });
      const input = screen.getByRole("combobox");
      const event = new window.KeyboardEvent("keydown", { key, bubbles: true });
      let prevented = false;
      event.preventDefault = () => {
        prevented = true;
      };
      input.dispatchEvent(event);
      expect(prevented).toBe(false);
    }
  );
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

describe("SearchablePalette Escape clears before it closes", () => {
  it("clears a query without the dialog's backstop closing the palette", () => {
    const onQueryChange = vi.fn();
    const onClose = vi.fn();
    renderPalette({ query: "abc", onQueryChange, onClose });

    fireEvent.keyDown(screen.getByRole("combobox"), { key: "Escape" });

    expect(onQueryChange).toHaveBeenCalledWith("");
    expect(onClose).not.toHaveBeenCalled();
  });

  it("closes on Escape once the field is empty", () => {
    const onClose = vi.fn();
    renderPalette({ query: "", onClose });

    fireEvent.keyDown(screen.getByRole("combobox"), { key: "Escape" });

    expect(onClose).toHaveBeenCalled();
  });
});

describe("SearchablePalette scroll and bands", () => {
  it("scrolls an unbanded cursor row into view even when rows carry no id", () => {
    const scrolled: string[] = [];
    Element.prototype.scrollIntoView = function (this: Element) {
      scrolled.push(this.textContent ?? "");
    };
    renderPalette({ selectedIndex: 1 });
    expect(scrolled).toContain(items[1]!.id);
  });

  it("heads each band with an inert option, never a role=group", () => {
    renderPalette({
      getSectionLabel: (item: Item) => (items.indexOf(item) < 1 ? "First" : "Second"),
      renderItem: (item: Item) => (
        <div key={item.id} id={`palette-option-${item.id}`} role="option" aria-selected={false}>
          {item.id}
        </div>
      ),
    });
    const list = screen.getByRole("listbox");
    expect(list.querySelectorAll('[role="group"]')).toHaveLength(0);
    const heads = [...list.querySelectorAll('[aria-disabled="true"]')];
    expect(heads.map((h) => h.getAttribute("aria-label"))).toEqual(["First", "Second"]);
  });
});

interface EmptyRenderArgs {
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
}: EmptyRenderArgs = {}) {
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

const footerItems: Item[] = [
  { id: "a", label: "Alpha" },
  { id: "b", label: "Bravo" },
  { id: "c", label: "Charlie" },
];

interface FooterRenderArgs {
  selectedIndex?: number;
  results?: Item[];
  footer?: React.ReactNode;
  getFooter?: (selectedItem: Item | null) => React.ReactNode;
  getActionLabel?: (selectedItem: Item) => string;
  tier?: PaletteSurfaceTier;
}

function renderFooterPalette({
  selectedIndex = 0,
  results = footerItems,
  footer,
  getFooter,
  getActionLabel,
  tier = "command",
}: FooterRenderArgs = {}) {
  return render(
    <SearchablePalette<Item>
      isOpen
      query=""
      results={results}
      selectedIndex={selectedIndex}
      onQueryChange={() => {}}
      onSelectPrevious={() => {}}
      onSelectNext={() => {}}
      onConfirm={() => {}}
      onClose={() => {}}
      getItemId={(item) => item.id}
      renderItem={(item) => (
        <button key={item.id} data-testid={`row-${item.id}`}>
          {item.label}
        </button>
      )}
      label="Test"
      ariaLabel="Test palette"
      tier={tier}
      footer={footer}
      getFooter={getFooter}
      getActionLabel={getActionLabel}
    />
  );
}

describe("SearchablePalette footer", () => {
  it("calls getFooter with the selected item", () => {
    const getFooter = vi.fn((item: Item | null) =>
      item ? <span data-testid="footer">{item.label}</span> : null
    );

    const { getByTestId } = renderFooterPalette({ selectedIndex: 1, getFooter });

    expect(getFooter).toHaveBeenCalledWith(footerItems[1]);
    expect(getByTestId("footer").textContent).toBe("Bravo");
  });

  it("calls getFooter with null when results are empty", () => {
    const getFooter = vi.fn((item: Item | null) =>
      item ? (
        <span data-testid="footer">{item.label}</span>
      ) : (
        <span data-testid="footer">empty</span>
      )
    );

    const { getByTestId } = renderFooterPalette({ results: [], selectedIndex: -1, getFooter });

    expect(getFooter).toHaveBeenCalledWith(null);
    expect(getByTestId("footer").textContent).toBe("empty");
  });

  it("getFooter takes precedence over the static footer prop", () => {
    const { getByTestId, queryByTestId } = renderFooterPalette({
      footer: <span data-testid="static-footer">static</span>,
      getFooter: () => <span data-testid="dynamic-footer">dynamic</span>,
    });

    expect(getByTestId("dynamic-footer")).toBeTruthy();
    expect(queryByTestId("static-footer")).toBeNull();
  });

  it("renders the static footer when getFooter is omitted", () => {
    const { getByTestId } = renderFooterPalette({
      footer: <span data-testid="static-footer">static</span>,
    });

    expect(getByTestId("static-footer").textContent).toBe("static");
  });

  it("forwards its tier to the shell instead of pinning one", () => {
    // SearchablePalette renders the dialog itself, so a hardcoded or dropped
    // tier here would leave the shell's own tier tests green while every
    // anchored consumer — SendToAgent, Worktree, QuickCreate — silently came
    // out at command width.
    const widthFor = (tier: "anchored" | "command") => {
      const { unmount } = renderFooterPalette({ tier });
      const dialog = document.body.querySelector("[role='dialog']");
      const match = /(?:^|\s)w-\[(\d+)px\]/.exec(dialog?.className ?? "");
      unmount();
      expect(match, `no w-[Npx] class for the ${tier} tier`).not.toBeNull();
      return Number(match![1]);
    };

    expect(widthFor("anchored")).toBeLessThan(widthFor("command"));
  });

  it("renders no footer band at all when no footer source is provided", () => {
    renderFooterPalette();

    // This fixture passes no `shortcut` and no `emptyShortcut`, so the footer
    // is the palette's only source of `kbd` chips — their absence is the band's
    // absence. (`AppPaletteDialog.Footer` covers the wrapper itself directly.)
    expect(document.body.querySelector("kbd")).toBeNull();
    expect(document.body.textContent).not.toContain("to select");
  });

  it("does not render an aria-live region for the footer", () => {
    renderFooterPalette({
      getFooter: (item) => (item ? <span data-testid="footer-content">{item.label}</span> : null),
    });

    // Scope the assertion to the footer container — the dialog itself mounts
    // an AccessibilityAnnouncer with two aria-live sr-only divs (intentional;
    // VoiceOver suppresses aria-live outside the focused aria-modal subtree).
    const footerContent = document.body.querySelector("[data-testid='footer-content']");
    const footerContainer = footerContent?.parentElement;
    expect(footerContainer).not.toBeNull();
    expect(footerContainer?.querySelector("[aria-live]")).toBeNull();
  });

  it("getActionLabel renders one contextual chip, not a navigation lesson", () => {
    renderFooterPalette({
      selectedIndex: 1,
      getActionLabel: (item) => (item ? `Switch to ${item.label}` : "Switch"),
    });

    // The footer names what Enter does and stops there. `↑↓` and `Esc` are
    // conventions every picker in the app shares, so restating them per surface
    // is chrome that teaches nothing.
    const keys = Array.from(document.body.querySelectorAll("kbd"), (el) => el.textContent);
    expect(keys).toEqual(["↵"]);
    expect(document.body.textContent).not.toContain("navigate");
    expect(document.body.textContent).not.toContain("close");
  });

  it("shows no Enter hint when results are empty", () => {
    const fn = vi.fn((item: Item) => `Switch ${item.label}`);
    renderFooterPalette({ results: [], selectedIndex: -1, getActionLabel: fn });

    expect(fn).not.toHaveBeenCalled();
    expect(document.body.querySelector("kbd")).toBeNull();
    expect(document.querySelector('[class*="palette-footer"]')).toBeNull();
  });

  it("getFooter takes precedence over getActionLabel", () => {
    const { getByTestId } = renderFooterPalette({
      getFooter: () => <span data-testid="dynamic-footer">dynamic</span>,
      getActionLabel: () => "Switch terminal",
    });

    expect(getByTestId("dynamic-footer")).toBeTruthy();
    expect(document.body.textContent).not.toContain("to switch terminal");
  });

  it("static footer takes precedence over getActionLabel", () => {
    const { getByTestId } = renderFooterPalette({
      footer: <span data-testid="static-footer">static</span>,
      getActionLabel: () => "Switch terminal",
    });

    expect(getByTestId("static-footer")).toBeTruthy();
    expect(document.body.textContent).not.toContain("to switch terminal");
  });

  it("falls back to 'Select' when getActionLabel returns a blank string", () => {
    renderFooterPalette({ getActionLabel: () => "   " });
    expect(document.body.textContent).toContain("to select");
  });

  it("explicit footer={false} suppresses the action-label path and renders no band", () => {
    renderFooterPalette({ footer: false, getActionLabel: () => "Switch terminal" });
    expect(document.body.textContent).not.toContain("to switch terminal");
    expect(document.body.textContent).not.toContain("to select");
    expect(document.body.querySelector("kbd")).toBeNull();
  });

  it("getActionLabel updates when selectedIndex moves to a different item", () => {
    const fn = (item: Item | null) => (item ? `Switch to ${item.label}` : "Pick");
    const { rerender } = render(
      <SearchablePalette<Item>
        isOpen
        query=""
        results={footerItems}
        selectedIndex={0}
        onQueryChange={() => {}}
        onSelectPrevious={() => {}}
        onSelectNext={() => {}}
        onConfirm={() => {}}
        onClose={() => {}}
        getItemId={(item) => item.id}
        renderItem={(item) => (
          <button key={item.id} data-testid={`row-${item.id}`}>
            {item.label}
          </button>
        )}
        label="Test"
        ariaLabel="Test palette"
        tier="command"
        getActionLabel={fn}
      />
    );
    expect(document.body.textContent).toContain("to switch to Alpha");

    rerender(
      <SearchablePalette<Item>
        isOpen
        query=""
        results={footerItems}
        selectedIndex={2}
        onQueryChange={() => {}}
        onSelectPrevious={() => {}}
        onSelectNext={() => {}}
        onConfirm={() => {}}
        onClose={() => {}}
        getItemId={(item) => item.id}
        renderItem={(item) => (
          <button key={item.id} data-testid={`row-${item.id}`}>
            {item.label}
          </button>
        )}
        label="Test"
        ariaLabel="Test palette"
        tier="command"
        getActionLabel={fn}
      />
    );
    expect(document.body.textContent).toContain("to switch to Charlie");
    expect(document.body.textContent).not.toContain("to switch to Alpha");
  });

  it("shows no Enter hint when selectedIndex is out of range", () => {
    const fn = vi.fn((item: Item) => `Switch ${item.label}`);
    renderFooterPalette({ selectedIndex: 99, getActionLabel: fn });
    expect(fn).not.toHaveBeenCalled();
    expect(document.body.textContent).not.toContain("to switch");
  });

  describe("footer stability when action label is unchanged", () => {
    function renderWithSelectedIndex(
      selectedIndex: number,
      getActionLabel: (item: Item | null) => string
    ) {
      return (
        <SearchablePalette<Item>
          isOpen
          query=""
          results={footerItems}
          selectedIndex={selectedIndex}
          onQueryChange={() => {}}
          onSelectPrevious={() => {}}
          onSelectNext={() => {}}
          onConfirm={() => {}}
          onClose={() => {}}
          getItemId={(item) => item.id}
          renderItem={(item) => (
            <button key={item.id} data-testid={`row-${item.id}`}>
              {item.label}
            </button>
          )}
          label="Test"
          ariaLabel="Test palette"
          tier="command"
          getActionLabel={getActionLabel}
        />
      );
    }

    it("does not rebuild the footer chip when the derived label is unchanged across selection moves", () => {
      // Stable label — the action verb is the same regardless of which item
      // is selected (e.g. "Switch terminal" in QuickSwitcher). This is the
      // exact regression #8106 documents: arrow-keying must not rebuild the
      // footer chip when the rendered text is identical.
      const stableLabel = (_item: Item | null) => "Switch terminal";

      const { rerender } = render(renderWithSelectedIndex(0, stableLabel));

      // Snapshot the footer DOM node identity. If the memoized JSX is stable
      // across selection changes, React reuses the same DOM nodes — the kbd
      // element under the footer keeps the same identity. The dialog portals
      // into document.body so query the body, not the render container.
      const initialDialog = document.body.querySelector("[role='dialog']");
      expect(initialDialog).not.toBeNull();
      const initialKbds = Array.from(initialDialog!.querySelectorAll("kbd"));
      // The footer carries exactly one chip now — the "↵" action.
      const initialPrimaryKbd = initialKbds.find((kbd) => kbd.textContent === "↵");
      expect(initialPrimaryKbd).toBeDefined();

      rerender(renderWithSelectedIndex(1, stableLabel));
      rerender(renderWithSelectedIndex(2, stableLabel));

      const finalDialog = document.body.querySelector("[role='dialog']");
      const finalPrimaryKbd = Array.from(finalDialog!.querySelectorAll("kbd")).find(
        (kbd) => kbd.textContent === "↵"
      );
      // Same DOM node identity proves React's reconciler bailed out — the
      // memoized JSX element kept the same reference so no remount occurred.
      expect(finalPrimaryKbd).toBe(initialPrimaryKbd);
      expect(document.body.textContent).toContain("to switch terminal");
    });
  });
});

const hoverItems: Item[] = [{ id: "a" }, { id: "b" }, { id: "c" }];

function renderHoverPalette(onHoverIndex?: (index: number) => void) {
  return render(
    <SearchablePalette<Item>
      isOpen
      query=""
      results={hoverItems}
      selectedIndex={0}
      onQueryChange={() => {}}
      onSelectPrevious={() => {}}
      onSelectNext={() => {}}
      onConfirm={() => {}}
      onClose={() => {}}
      getItemId={(item) => item.id}
      onHoverIndex={onHoverIndex}
      renderItem={(item, index, isSelected, hoverIndex) => (
        <button
          key={item.id}
          data-testid={`row-${item.id}`}
          aria-selected={isSelected}
          onPointerMove={() => hoverIndex(index)}
        >
          {item.id}
        </button>
      )}
      label="Test"
      ariaLabel="Test palette"
      tier="command"
    />
  );
}

describe("SearchablePalette hover wiring", () => {
  it("calls onHoverIndex with the correct index when a row's pointer move fires", () => {
    const onHoverIndex = vi.fn();
    const { getByTestId } = renderHoverPalette(onHoverIndex);

    fireEvent.pointerMove(getByTestId("row-c"));
    expect(onHoverIndex).toHaveBeenCalledWith(2);

    fireEvent.pointerMove(getByTestId("row-a"));
    expect(onHoverIndex).toHaveBeenCalledWith(0);

    expect(onHoverIndex).toHaveBeenCalledTimes(2);
  });

  it("supplies a stable noop hover callback when onHoverIndex is omitted", () => {
    const { getByTestId } = renderHoverPalette();
    expect(() => fireEvent.pointerMove(getByTestId("row-b"))).not.toThrow();
  });

  it("moves the cursor with the pointer without scrolling it, but still reveals for the keys", () => {
    const scrollIntoView = vi.fn();
    Element.prototype.scrollIntoView = scrollIntoView;

    function Harness() {
      const [selectedIndex, setSelectedIndex] = useState(0);
      return (
        <SearchablePalette<Item>
          isOpen
          query=""
          results={hoverItems}
          selectedIndex={selectedIndex}
          onQueryChange={() => {}}
          onSelectPrevious={() => setSelectedIndex((i) => Math.max(0, i - 1))}
          onSelectNext={() => setSelectedIndex((i) => Math.min(hoverItems.length - 1, i + 1))}
          onConfirm={() => {}}
          onClose={() => {}}
          getItemId={(item) => item.id}
          onHoverIndex={setSelectedIndex}
          renderItem={(item, index, isSelected, hoverIndex) => (
            <button
              key={item.id}
              data-testid={`row-${item.id}`}
              aria-selected={isSelected}
              onPointerMove={() => hoverIndex(index)}
            >
              {item.id}
            </button>
          )}
          label="Test"
          ariaLabel="Test palette"
          tier="command"
        />
      );
    }

    const { getByTestId, getByRole } = render(<Harness />);
    scrollIntoView.mockClear();

    // jsdom has no pointer, so `:hover` is stubbed onto the row being pointed at.
    const realMatches = Element.prototype.matches;
    let hovered: Element | null = null;
    Element.prototype.matches = function (this: Element, selector: string) {
      if (selector === ":hover") return this === hovered;
      return realMatches.call(this, selector);
    } as typeof realMatches;

    // The row under the pointer takes the cursor, and stays where it is.
    hovered = getByTestId("row-c");
    fireEvent.pointerMove(getByTestId("row-c"));
    expect(getByTestId("row-c").getAttribute("aria-selected")).toBe("true");
    expect(scrollIntoView).not.toHaveBeenCalled();

    // The keys still bring the row they land on into view — even when it is
    // the row beneath the resting pointer.
    hovered = getByTestId("row-b");
    fireEvent.keyDown(getByRole("combobox"), { key: "ArrowUp" });
    expect(getByTestId("row-b").getAttribute("aria-selected")).toBe("true");
    expect(scrollIntoView).toHaveBeenCalled();
    Element.prototype.matches = realMatches;
  });
});

function renderLoadingPalette({ isLoading, results }: { isLoading?: boolean; results: Item[] }) {
  return render(
    <SearchablePalette<Item>
      isOpen
      query=""
      results={results}
      selectedIndex={0}
      onQueryChange={() => {}}
      onSelectPrevious={() => {}}
      onSelectNext={() => {}}
      onConfirm={() => {}}
      onClose={() => {}}
      getItemId={(item) => item.id}
      renderItem={(item) => <div key={item.id}>{item.id}</div>}
      label="Test"
      ariaLabel="Test palette"
      tier="command"
      emptyMessage="No items available"
      isLoading={isLoading}
    />
  );
}

describe("SearchablePalette loading + empty state", () => {
  it("suppresses the empty state while isLoading is true and results are empty", () => {
    renderLoadingPalette({ isLoading: true, results: [] });
    expect(screen.queryByText("No items available")).toBeNull();
    // The header progress bar is the only loading affordance — assert it's
    // present and marked active so a screen reader doesn't get a misleading
    // empty-state announcement layered on top.
    const bar = document.querySelector<HTMLElement>(".palette-loading-bar");
    expect(bar?.dataset.loading).toBe("true");
  });

  it("shows the empty state when isLoading is false and results are empty", () => {
    renderLoadingPalette({ isLoading: false, results: [] });
    expect(screen.getByText("No items available")).toBeTruthy();
  });

  it("renders the listbox normally when isLoading is true but results exist", () => {
    renderLoadingPalette({ isLoading: true, results: [{ id: "a" }] });
    expect(screen.getByRole("listbox")).toBeTruthy();
    expect(screen.queryByText("No items available")).toBeNull();
  });
});

function renderStalePalette(isFiltering: boolean | undefined) {
  return render(
    <SearchablePalette<Item>
      isOpen
      query="a"
      results={items}
      selectedIndex={0}
      onQueryChange={() => {}}
      onSelectPrevious={() => {}}
      onSelectNext={() => {}}
      onConfirm={() => {}}
      onClose={() => {}}
      getItemId={(item) => item.id}
      renderItem={(item) => <div key={item.id}>{item.id}</div>}
      label="Test"
      ariaLabel="Test palette"
      tier="command"
      listId="test-palette-list"
      isFiltering={isFiltering}
    />
  );
}

describe("SearchablePalette stale visual", () => {
  it("applies palette-results-stale to the listbox when isFiltering is true", () => {
    renderStalePalette(true);
    const listbox = screen.getByRole("listbox");
    expect(listbox.classList.contains("palette-results-stale")).toBe(true);
    expect(listbox.getAttribute("data-stale")).toBe("true");
  });

  it("omits the class when isFiltering is false", () => {
    renderStalePalette(false);
    const listbox = screen.getByRole("listbox");
    expect(listbox.classList.contains("palette-results-stale")).toBe(false);
    expect(listbox.getAttribute("data-stale")).toBeNull();
  });
});

describe("SearchablePalette aria-busy on listbox", () => {
  it("sets aria-busy='true' when isFiltering is true", () => {
    renderStalePalette(true);
    const listbox = screen.getByRole("listbox");
    expect(listbox.getAttribute("aria-busy")).toBe("true");
  });

  it("omits aria-busy when isFiltering is false", () => {
    renderStalePalette(false);
    const listbox = screen.getByRole("listbox");
    expect(listbox.hasAttribute("aria-busy")).toBe(false);
  });
});

describe("SearchablePalette combobox input ARIA", () => {
  it("has aria-autocomplete='list'", () => {
    renderStalePalette(undefined);
    const input = screen.getByRole("combobox");
    expect(input.getAttribute("aria-autocomplete")).toBe("list");
  });
});

function renderAnnouncePalette(initial: { query: string; results: Item[]; isFiltering: boolean }) {
  const props = {
    isOpen: true,
    query: initial.query,
    results: initial.results,
    selectedIndex: 0,
    onQueryChange: () => {},
    onSelectPrevious: () => {},
    onSelectNext: () => {},
    onConfirm: () => {},
    onClose: () => {},
    getItemId: (item: Item) => item.id,
    renderItem: (item: Item) => <div key={item.id}>{item.id}</div>,
    label: "Test",
    ariaLabel: "Test palette",
    tier: "command" as const,
    isFiltering: initial.isFiltering,
  };
  return render(<SearchablePalette<Item> {...props} />);
}

describe("SearchablePalette filter-result live announcement", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    announceMock.mockClear();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("announces the result count after isFiltering transitions to false", () => {
    const items = [{ id: "a" }, { id: "b" }, { id: "c" }];
    const { rerender } = renderAnnouncePalette({ query: "x", results: items, isFiltering: true });

    rerender(
      <SearchablePalette<Item>
        isOpen
        query="x"
        results={items}
        selectedIndex={0}
        onQueryChange={() => {}}
        onSelectPrevious={() => {}}
        onSelectNext={() => {}}
        onConfirm={() => {}}
        onClose={() => {}}
        getItemId={(item) => item.id}
        renderItem={(item) => <div key={item.id}>{item.id}</div>}
        label="Test"
        ariaLabel="Test palette"
        tier="command"
        isFiltering={false}
      />
    );

    expect(announceMock).not.toHaveBeenCalled();
    vi.advanceTimersByTime(400);
    expect(announceMock).toHaveBeenCalledTimes(1);
    expect(announceMock).toHaveBeenCalledWith("3 results", "polite");
  });

  it("announces a synchronously filtered query change, which never reports isFiltering", () => {
    const all = [{ id: "a" }, { id: "b" }, { id: "c" }];
    const { rerender } = renderAnnouncePalette({ query: "", results: all, isFiltering: false });

    rerender(
      <SearchablePalette<Item>
        isOpen
        query="a"
        results={[{ id: "a" }, { id: "b" }]}
        selectedIndex={0}
        onQueryChange={() => {}}
        onSelectPrevious={() => {}}
        onSelectNext={() => {}}
        onConfirm={() => {}}
        onClose={() => {}}
        getItemId={(item) => item.id}
        renderItem={(item) => <div key={item.id}>{item.id}</div>}
        label="Test"
        ariaLabel="Test palette"
        tier="command"
        isFiltering={false}
      />
    );

    expect(announceMock).not.toHaveBeenCalled();
    vi.advanceTimersByTime(400);
    expect(announceMock).toHaveBeenCalledTimes(1);
    expect(announceMock).toHaveBeenCalledWith("2 results", "polite");
  });

  it("uses singular phrasing for exactly one result", () => {
    const items = [{ id: "a" }];
    const { rerender } = renderAnnouncePalette({ query: "x", results: items, isFiltering: true });

    rerender(
      <SearchablePalette<Item>
        isOpen
        query="x"
        results={items}
        selectedIndex={0}
        onQueryChange={() => {}}
        onSelectPrevious={() => {}}
        onSelectNext={() => {}}
        onConfirm={() => {}}
        onClose={() => {}}
        getItemId={(item) => item.id}
        renderItem={(item) => <div key={item.id}>{item.id}</div>}
        label="Test"
        ariaLabel="Test palette"
        tier="command"
        isFiltering={false}
      />
    );

    vi.advanceTimersByTime(400);
    expect(announceMock).toHaveBeenCalledWith("1 result", "polite");
  });

  it("skips the announcement when the query is empty", () => {
    const items = [{ id: "a" }];
    const { rerender } = renderAnnouncePalette({ query: "", results: items, isFiltering: true });

    rerender(
      <SearchablePalette<Item>
        isOpen
        query=""
        results={items}
        selectedIndex={0}
        onQueryChange={() => {}}
        onSelectPrevious={() => {}}
        onSelectNext={() => {}}
        onConfirm={() => {}}
        onClose={() => {}}
        getItemId={(item) => item.id}
        renderItem={(item) => <div key={item.id}>{item.id}</div>}
        label="Test"
        ariaLabel="Test palette"
        tier="command"
        isFiltering={false}
      />
    );

    vi.advanceTimersByTime(400);
    expect(announceMock).not.toHaveBeenCalled();
  });

  it("cancels the pending announcement if isFiltering flips back to true", () => {
    const items = [{ id: "a" }, { id: "b" }];
    const { rerender } = renderAnnouncePalette({ query: "x", results: items, isFiltering: true });

    const renderProps = (isFiltering: boolean, query: string) => (
      <SearchablePalette<Item>
        isOpen
        query={query}
        results={items}
        selectedIndex={0}
        onQueryChange={() => {}}
        onSelectPrevious={() => {}}
        onSelectNext={() => {}}
        onConfirm={() => {}}
        onClose={() => {}}
        getItemId={(item) => item.id}
        renderItem={(item) => <div key={item.id}>{item.id}</div>}
        label="Test"
        ariaLabel="Test palette"
        tier="command"
        isFiltering={isFiltering}
      />
    );

    rerender(renderProps(false, "x"));
    vi.advanceTimersByTime(100);
    rerender(renderProps(true, "xy"));
    vi.advanceTimersByTime(500);

    expect(announceMock).not.toHaveBeenCalled();
  });

  it("leaves a zero-result pass to the empty state's own announcement", () => {
    const { rerender } = renderAnnouncePalette({ query: "zz", results: [], isFiltering: true });
    rerender(
      <SearchablePalette<Item>
        isOpen
        query="zz"
        results={[]}
        selectedIndex={0}
        onQueryChange={() => {}}
        onSelectPrevious={() => {}}
        onSelectNext={() => {}}
        onConfirm={() => {}}
        onClose={() => {}}
        getItemId={(item) => item.id}
        renderItem={(item) => <div key={item.id}>{item.id}</div>}
        label="Test"
        ariaLabel="Test palette"
        tier="command"
        isFiltering={false}
      />
    );
    vi.advanceTimersByTime(400);
    expect(announceMock).not.toHaveBeenCalled();
  });

  it("still announces a zero count for a custom body, which draws no empty state", () => {
    const body = () => <div />;
    const { rerender } = render(
      <SearchablePalette<Item>
        isOpen
        query="zz"
        results={[]}
        selectedIndex={0}
        onQueryChange={() => {}}
        onSelectPrevious={() => {}}
        onSelectNext={() => {}}
        onConfirm={() => {}}
        onClose={() => {}}
        getItemId={(item) => item.id}
        renderItem={(item) => <div key={item.id}>{item.id}</div>}
        renderBody={body}
        label="Test"
        ariaLabel="Test palette"
        tier="command"
        isFiltering
      />
    );
    rerender(
      <SearchablePalette<Item>
        isOpen
        query="zz"
        results={[]}
        selectedIndex={0}
        onQueryChange={() => {}}
        onSelectPrevious={() => {}}
        onSelectNext={() => {}}
        onConfirm={() => {}}
        onClose={() => {}}
        getItemId={(item) => item.id}
        renderItem={(item) => <div key={item.id}>{item.id}</div>}
        renderBody={body}
        label="Test"
        ariaLabel="Test palette"
        tier="command"
        isFiltering={false}
      />
    );
    vi.advanceTimersByTime(400);
    expect(announceMock).toHaveBeenCalledWith("0 results", "polite");
  });
});

describe("SearchablePalette loading announcement", () => {
  const base = {
    isOpen: true,
    query: "",
    selectedIndex: 0,
    onQueryChange: () => {},
    onSelectPrevious: () => {},
    onSelectNext: () => {},
    onConfirm: () => {},
    onClose: () => {},
    getItemId: (item: Item) => item.id,
    renderItem: (item: Item) => <div key={item.id}>{item.id}</div>,
    label: "Test",
    ariaLabel: "Test palette",
    tier: "command" as const,
  };

  beforeEach(() => {
    vi.useFakeTimers();
    announceMock.mockClear();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("says nothing for a load that lands inside the gate", () => {
    const { rerender } = render(<SearchablePalette<Item> {...base} results={[]} isLoading />);
    vi.advanceTimersByTime(200);
    rerender(<SearchablePalette<Item> {...base} results={[{ id: "a" }]} isLoading={false} />);
    vi.advanceTimersByTime(1000);
    expect(announceMock).not.toHaveBeenCalled();
  });

  it("announces a slow load, then what it brought", () => {
    const { rerender } = render(<SearchablePalette<Item> {...base} results={[]} isLoading />);
    vi.advanceTimersByTime(400);
    expect(announceMock).toHaveBeenCalledTimes(1);
    rerender(
      <SearchablePalette<Item> {...base} results={[{ id: "a" }, { id: "b" }]} isLoading={false} />
    );
    vi.advanceTimersByTime(400);
    expect(announceMock).toHaveBeenCalledTimes(2);
    expect(announceMock).toHaveBeenLastCalledWith("2 results", "polite");
  });

  it("leaves an empty landing to the empty state", () => {
    const { rerender } = render(<SearchablePalette<Item> {...base} results={[]} isLoading />);
    vi.advanceTimersByTime(400);
    rerender(<SearchablePalette<Item> {...base} results={[]} isLoading={false} />);
    vi.advanceTimersByTime(1000);
    expect(announceMock).toHaveBeenCalledTimes(1);
  });

  it("does not restart the loading announcement when rows arrive mid-load", () => {
    const { rerender } = render(<SearchablePalette<Item> {...base} results={[]} isLoading />);
    vi.advanceTimersByTime(300);
    rerender(<SearchablePalette<Item> {...base} results={[{ id: "a" }]} isLoading />);
    vi.advanceTimersByTime(150);
    expect(announceMock).toHaveBeenCalledTimes(1);
    rerender(<SearchablePalette<Item> {...base} results={[{ id: "a" }, { id: "b" }]} isLoading />);
    vi.advanceTimersByTime(1000);
    expect(announceMock).toHaveBeenCalledTimes(1);
  });

  it("speaks one count when a load and a filter pass settle together", () => {
    const { rerender } = render(
      <SearchablePalette<Item> {...base} query="a" results={[]} isLoading isFiltering />
    );
    vi.advanceTimersByTime(400);
    announceMock.mockClear();
    rerender(
      <SearchablePalette<Item>
        {...base}
        query="a"
        results={[{ id: "a" }]}
        isLoading={false}
        isFiltering={false}
      />
    );
    vi.advanceTimersByTime(1000);
    expect(announceMock).toHaveBeenCalledTimes(1);
    expect(announceMock).toHaveBeenCalledWith("1 result", "polite");
  });
});
