// @vitest-environment jsdom
import { useRef } from "react";
import { render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useScopedSelectAll } from "../useScopedSelectAll";

/**
 * Mirrors the focus topology the hook has to cope with. DOM focus lands on the
 * pane root (`ContentPanel`'s `tabIndex={-1}` div, keyed by `data-panel-id`),
 * which is an *ancestor* of the viewer body; or on the tree beside it, which is
 * a *sibling*; or inside the body itself. `#outside` stands in for the sidebar
 * the native command wrongly swept into the selection (#12135).
 */
function Harness({ enabled = true, bodyText = "document text" }) {
  const ref = useRef<HTMLDivElement>(null);
  useScopedSelectAll(ref, enabled);
  return (
    <div data-testid="pane" data-panel-id="pane-1" tabIndex={-1}>
      <div data-testid="toolbar">
        <input data-testid="search" />
        <textarea data-testid="notes" />
        <button type="button" data-testid="toolbar-button">
          Refresh
        </button>
      </div>
      <div data-testid="tree" tabIndex={-1}>
        tree row
      </div>
      <div data-testid="body" ref={ref}>
        <p>{bodyText}</p>
        <a href="#x" data-testid="doc-link">
          link
        </a>
      </div>
    </div>
  );
}

function pressSelectAll(target: Element, init: Partial<KeyboardEventInit> = {}): KeyboardEvent {
  const event = new KeyboardEvent("keydown", {
    key: "a",
    metaKey: true,
    bubbles: true,
    cancelable: true,
    ...init,
  });
  target.dispatchEvent(event);
  return event;
}

function selectedText(): string {
  return window.getSelection()?.toString() ?? "";
}

function clearSelection(): void {
  window.getSelection()?.removeAllRanges();
}

/**
 * jsdom performs no native Select All, so "nothing was selected" is true of a
 * hook that never ran at all. Every declining case therefore has to prove the
 * listener was live and *chose* to decline — otherwise deleting the hook
 * outright would leave the test green.
 */
function expectStillLive(body: Element, pane: Element): void {
  clearSelection();
  const control = pressSelectAll(pane);
  expect(control.defaultPrevented).toBe(true);
  expect(window.getSelection()?.getRangeAt(0).commonAncestorContainer).toBe(body);
  clearSelection();
}

/** The whole region, not a collapsed range that merely shares its ancestor. */
function expectSelectedWholeOf(container: HTMLElement): void {
  const range = window.getSelection()?.getRangeAt(0);
  expect(range?.commonAncestorContainer).toBe(container);
  expect(range?.startOffset).toBe(0);
  expect(range?.endOffset).toBe(container.childNodes.length);
  expect(selectedText()).toBe(container.textContent);
}

beforeEach(clearSelection);
afterEach(() => {
  vi.restoreAllMocks();
  clearSelection();
});

describe("useScopedSelectAll", () => {
  it("selects the whole region when focus sits on the ancestor pane root", () => {
    const { getByTestId } = render(<Harness />);

    const event = pressSelectAll(getByTestId("pane"));

    // preventDefault is the half that suppresses Electron's native accelerator:
    // AppKit never sees a key the page already handled.
    expect(event.defaultPrevented).toBe(true);
    expectSelectedWholeOf(getByTestId("body"));
    expect(selectedText()).toContain("document text");
    expect(selectedText()).not.toContain("Refresh");
  });

  it("claims the chord when focus is inside the region", () => {
    const { getByTestId } = render(<Harness />);

    const event = pressSelectAll(getByTestId("doc-link"));

    expect(event.defaultPrevented).toBe(true);
    expectSelectedWholeOf(getByTestId("body"));
  });

  // The file browser focuses its tree root on a row click and leaves it there,
  // so the preview beside it is a sibling of the focused element — the most
  // common path into the reported bug, and one an ancestor-only rule misses.
  it("claims the chord when focus is on a sibling inside the same pane", () => {
    const { getByTestId } = render(<Harness />);

    const fromTree = pressSelectAll(getByTestId("tree"));
    expect(fromTree.defaultPrevented).toBe(true);
    expectSelectedWholeOf(getByTestId("body"));

    clearSelection();
    const fromToolbar = pressSelectAll(getByTestId("toolbar-button"));
    expect(fromToolbar.defaultPrevented).toBe(true);
    expectSelectedWholeOf(getByTestId("body"));
  });

  it("treats Ctrl+A the same way, for Windows and Linux", () => {
    const { getByTestId } = render(<Harness />);

    const event = pressSelectAll(getByTestId("pane"), { metaKey: false, ctrlKey: true });

    expect(event.defaultPrevented).toBe(true);
    expectSelectedWholeOf(getByTestId("body"));
  });

  // Caps Lock produces "A" with shiftKey false; Shift+Cmd+A is a different
  // chord and must stay excluded.
  it("accepts a capitalised key but not the Shift chord", () => {
    const { getByTestId } = render(<Harness />);

    expect(pressSelectAll(getByTestId("pane"), { key: "A" }).defaultPrevented).toBe(true);
    expectSelectedWholeOf(getByTestId("body"));

    clearSelection();
    expect(pressSelectAll(getByTestId("pane"), { key: "A", shiftKey: true }).defaultPrevented).toBe(
      false
    );
    expect(window.getSelection()?.rangeCount ?? 0).toBe(0);
  });

  it("leaves Cmd+A in a text field to the field", () => {
    const { getByTestId } = render(<Harness />);

    for (const id of ["search", "notes"]) {
      const event = pressSelectAll(getByTestId(id));
      expect(event.defaultPrevented).toBe(false);
      expect(window.getSelection()?.rangeCount ?? 0).toBe(0);
    }

    const editable = document.createElement("div");
    // jsdom does not derive isContentEditable from the attribute.
    Object.defineProperty(editable, "isContentEditable", { value: true });
    getByTestId("toolbar").appendChild(editable);
    expect(pressSelectAll(editable).defaultPrevented).toBe(false);
    expect(window.getSelection()?.rangeCount ?? 0).toBe(0);

    expectStillLive(getByTestId("body"), getByTestId("pane"));
  });

  it("yields to a higher-priority owner that already claimed the chord", () => {
    const { getByTestId } = render(<Harness />);
    const pane = getByTestId("pane");
    // An explicit user keybinding, or an inner editor, handled it first.
    pane.addEventListener("keydown", (e) => e.preventDefault(), { once: true });

    pressSelectAll(pane);

    expect(window.getSelection()?.rangeCount ?? 0).toBe(0);
    expectStillLive(getByTestId("body"), pane);
  });

  it("ignores a keystroke the IME is still composing", () => {
    const { getByTestId } = render(<Harness />);

    const event = pressSelectAll(getByTestId("pane"), { isComposing: true });

    expect(event.defaultPrevented).toBe(false);
    expect(window.getSelection()?.rangeCount ?? 0).toBe(0);
    expectStillLive(getByTestId("body"), getByTestId("pane"));
  });

  it("ignores modified variants that are not Select All", () => {
    const { getByTestId } = render(<Harness />);
    const pane = getByTestId("pane");

    expect(pressSelectAll(pane, { altKey: true }).defaultPrevented).toBe(false);
    expect(pressSelectAll(pane, { metaKey: false }).defaultPrevented).toBe(false);
    expect(pressSelectAll(pane, { key: "b" }).defaultPrevented).toBe(false);
    expect(window.getSelection()?.rangeCount ?? 0).toBe(0);

    expectStillLive(getByTestId("body"), pane);
  });

  it("declines a target outside its own pane", () => {
    const { getByTestId } = render(<Harness />);
    const outsider = document.createElement("div");
    outsider.textContent = "sidebar";
    document.body.appendChild(outsider);

    const event = pressSelectAll(outsider);

    expect(event.defaultPrevented).toBe(false);
    expect(window.getSelection()?.rangeCount ?? 0).toBe(0);
    expectStillLive(getByTestId("body"), getByTestId("pane"));
    outsider.remove();
  });

  it("lets only the pane owning the keydown target act, with two mounted", () => {
    const first = render(<Harness bodyText="first document" />);
    const second = render(<Harness bodyText="second document" />);
    // RTL binds queries to document.body, which now holds both harnesses —
    // reach through each render's own container instead.
    const secondPane = second.container.querySelector<HTMLElement>('[data-testid="pane"]')!;

    pressSelectAll(secondPane);

    expect(selectedText()).toContain("second document");
    expect(selectedText()).not.toContain("first document");

    first.unmount();
    second.unmount();
  });

  // F6 focuses the grid's macro-region wrapper, which encloses every open pane.
  // An unbounded "is the target an ancestor?" rule would let each mounted
  // viewer claim that keypress and leave mount order to pick the winner.
  it("declines when focus is on an ancestor enclosing several panes", () => {
    const macroRegion = document.createElement("div");
    macroRegion.tabIndex = -1;
    document.body.appendChild(macroRegion);
    const first = render(<Harness bodyText="first document" />, { container: macroRegion });
    const second = render(<Harness bodyText="second document" />, {
      container: macroRegion.appendChild(document.createElement("div")),
    });

    const event = pressSelectAll(macroRegion);

    expect(event.defaultPrevented).toBe(false);
    expect(window.getSelection()?.rangeCount ?? 0).toBe(0);

    // Both listeners were live and both declined — neither pane won a lottery.
    const firstPane = first.container.querySelector<HTMLElement>('[data-testid="pane"]')!;
    expectStillLive(firstPane.querySelector<HTMLElement>('[data-testid="body"]')!, firstPane);

    first.unmount();
    second.unmount();
    macroRegion.remove();
  });

  // A panel opened as a dialog puts Close and "Open as panel" in the dialog
  // header — outside the panel root, inside the dialog — and AppDialog focuses
  // one of them on open, so that is where the first Cmd+A lands.
  it("claims the chord from the dialog header above its own pane", () => {
    const { getByTestId } = render(
      <div role="dialog" data-testid="dialog">
        <header>
          <button type="button" data-testid="dialog-close">
            Close
          </button>
        </header>
        <Harness />
      </div>
    );

    const event = pressSelectAll(getByTestId("dialog-close"));

    expect(event.defaultPrevented).toBe(true);
    expectSelectedWholeOf(getByTestId("body"));
  });

  it("attaches, detaches, and re-attaches its listener with `enabled`", () => {
    const { getByTestId, rerender } = render(<Harness enabled={false} />);
    const pane = getByTestId("pane");

    expect(pressSelectAll(pane).defaultPrevented).toBe(false);

    rerender(<Harness enabled={true} />);
    expect(pressSelectAll(pane).defaultPrevented).toBe(true);
    clearSelection();

    rerender(<Harness enabled={false} />);
    expect(pressSelectAll(pane).defaultPrevented).toBe(false);
    expect(window.getSelection()?.rangeCount ?? 0).toBe(0);

    rerender(<Harness enabled={true} />);
    expect(pressSelectAll(pane).defaultPrevented).toBe(true);
  });

  it("removes the exact listener it added on unmount", () => {
    // Unmount also detaches the tree, so a keydown after it can't reach
    // `document` either way — the only honest proof is handler identity.
    const added = new Set<EventListenerOrEventListenerObject>();
    const addSpy = vi
      .spyOn(document, "addEventListener")
      .mockImplementation((type, handler, opts) => {
        if (type === "keydown") added.add(handler);
        return HTMLDocument.prototype.addEventListener.call(document, type, handler, opts);
      });

    const { unmount } = render(<Harness />);
    addSpy.mockRestore();
    expect(added.size).toBe(1);

    const removed = new Set<EventListenerOrEventListenerObject>();
    vi.spyOn(document, "removeEventListener").mockImplementation((type, handler, opts) => {
      if (type === "keydown") removed.add(handler);
      return HTMLDocument.prototype.removeEventListener.call(document, type, handler, opts);
    });

    unmount();

    expect([...added].every((handler) => removed.has(handler))).toBe(true);
  });
});
