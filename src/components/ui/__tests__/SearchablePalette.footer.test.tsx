// @vitest-environment jsdom
import { render } from "@testing-library/react";
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

import { SearchablePalette } from "../SearchablePalette";

interface Item {
  id: string;
  label: string;
}

const items: Item[] = [
  { id: "a", label: "Alpha" },
  { id: "b", label: "Bravo" },
  { id: "c", label: "Charlie" },
];

interface RenderArgs {
  selectedIndex?: number;
  results?: Item[];
  footer?: React.ReactNode;
  getFooter?: (selectedItem: Item | null) => React.ReactNode;
  getActionLabel?: (selectedItem: Item | null) => string;
}

function renderPalette({
  selectedIndex = 0,
  results = items,
  footer,
  getFooter,
  getActionLabel,
}: RenderArgs = {}) {
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
      tier="command"
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

    const { getByTestId } = renderPalette({ selectedIndex: 1, getFooter });

    expect(getFooter).toHaveBeenCalledWith(items[1]);
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

    const { getByTestId } = renderPalette({ results: [], selectedIndex: -1, getFooter });

    expect(getFooter).toHaveBeenCalledWith(null);
    expect(getByTestId("footer").textContent).toBe("empty");
  });

  it("getFooter takes precedence over the static footer prop", () => {
    const { getByTestId, queryByTestId } = renderPalette({
      footer: <span data-testid="static-footer">static</span>,
      getFooter: () => <span data-testid="dynamic-footer">dynamic</span>,
    });

    expect(getByTestId("dynamic-footer")).toBeTruthy();
    expect(queryByTestId("static-footer")).toBeNull();
  });

  it("renders the static footer when getFooter is omitted", () => {
    const { getByTestId } = renderPalette({
      footer: <span data-testid="static-footer">static</span>,
    });

    expect(getByTestId("static-footer").textContent).toBe("static");
  });

  it("renders no footer band at all when no footer source is provided", () => {
    renderPalette();

    // Not merely "no hint text": the band itself must be absent. A palette that
    // has nothing to say about Enter should not spend a bordered strip saying
    // so, and an empty wrapper would still draw its top border and padding.
    expect(document.body.querySelector("kbd")).toBeNull();
    expect(document.body.textContent).not.toContain("to select");
    expect(document.body.querySelector(".border-t")).toBeNull();
  });

  it("does not render an aria-live region for the footer", () => {
    renderPalette({
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

  it("getActionLabel composes a custom verb into the footer hint", () => {
    renderPalette({
      selectedIndex: 1,
      getActionLabel: (item) => (item ? `Switch to ${item.label}` : "Switch"),
    });

    expect(document.body.textContent).toContain("to switch to bravo");
    expect(document.body.textContent).not.toContain("to select");
  });

  it("getActionLabel renders one contextual chip, not a navigation lesson", () => {
    renderPalette({
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

  it("getActionLabel receives null when results are empty", () => {
    const fn = vi.fn((item: Item | null) => (item ? `Switch ${item.label}` : "Pick"));
    renderPalette({ results: [], selectedIndex: -1, getActionLabel: fn });

    expect(fn).toHaveBeenCalledWith(null);
    expect(document.body.textContent).toContain("to pick");
  });

  it("getFooter takes precedence over getActionLabel", () => {
    const { getByTestId } = renderPalette({
      getFooter: () => <span data-testid="dynamic-footer">dynamic</span>,
      getActionLabel: () => "Switch terminal",
    });

    expect(getByTestId("dynamic-footer")).toBeTruthy();
    expect(document.body.textContent).not.toContain("to switch terminal");
  });

  it("static footer takes precedence over getActionLabel", () => {
    const { getByTestId } = renderPalette({
      footer: <span data-testid="static-footer">static</span>,
      getActionLabel: () => "Switch terminal",
    });

    expect(getByTestId("static-footer")).toBeTruthy();
    expect(document.body.textContent).not.toContain("to switch terminal");
  });

  it("falls back to 'Select' when getActionLabel returns a blank string", () => {
    renderPalette({ getActionLabel: () => "   " });
    expect(document.body.textContent).toContain("to select");
  });

  it("explicit footer={false} suppresses the action-label path and renders no band", () => {
    renderPalette({ footer: false, getActionLabel: () => "Switch terminal" });
    expect(document.body.textContent).not.toContain("to switch terminal");
    expect(document.body.textContent).not.toContain("to select");
    expect(document.body.querySelector(".border-t")).toBeNull();
  });

  it("getActionLabel updates when selectedIndex moves to a different item", () => {
    const fn = (item: Item | null) => (item ? `Switch to ${item.label}` : "Pick");
    const { rerender } = render(
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
    expect(document.body.textContent).toContain("to switch to alpha");

    rerender(
      <SearchablePalette<Item>
        isOpen
        query=""
        results={items}
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
    expect(document.body.textContent).toContain("to switch to charlie");
    expect(document.body.textContent).not.toContain("to switch to alpha");
  });

  it("getActionLabel receives null when selectedIndex is out of range", () => {
    const fn = vi.fn((item: Item | null) => (item ? `Switch ${item.label}` : "Fallback"));
    renderPalette({ selectedIndex: 99, getActionLabel: fn });
    expect(fn).toHaveBeenCalledWith(null);
    expect(document.body.textContent).toContain("to fallback");
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
          results={items}
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

    it("rebuilds the footer chip when the derived label changes across selection moves", () => {
      const labelFn = (item: Item | null) => (item ? `Switch to ${item.label}` : "Pick");

      const { rerender } = render(renderWithSelectedIndex(0, labelFn));
      expect(document.body.textContent).toContain("to switch to alpha");

      rerender(renderWithSelectedIndex(1, labelFn));
      expect(document.body.textContent).toContain("to switch to bravo");
      expect(document.body.textContent).not.toContain("to switch to alpha");
    });
  });
});
