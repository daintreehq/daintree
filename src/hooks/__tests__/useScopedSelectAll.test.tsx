// @vitest-environment jsdom
import { useRef } from "react";
import { render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useScopedSelectAll } from "../useScopedSelectAll";

/**
 * Mirrors the real shape the hook has to cope with: DOM focus sits on the
 * panel root (`ContentPanel`'s `tabIndex={-1}` div), which is an *ancestor* of
 * the viewer body — so the interception can never be a listener on the body
 * itself. `#chrome` stands in for the sidebar/toolbar the native command
 * wrongly swept into the selection (#12135).
 */
function Harness({ enabled = true, bodyText = "document text" }) {
  const ref = useRef<HTMLDivElement>(null);
  useScopedSelectAll(ref, enabled);
  return (
    <div data-testid="panel-root" tabIndex={-1}>
      <div data-testid="toolbar">
        <input data-testid="search" />
        <button type="button" data-testid="toolbar-button">
          Refresh
        </button>
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

beforeEach(() => {
  window.getSelection()?.removeAllRanges();
});

afterEach(() => {
  vi.restoreAllMocks();
  window.getSelection()?.removeAllRanges();
});

describe("useScopedSelectAll", () => {
  it("scopes Cmd+A to the region when focus sits on an ancestor panel root", () => {
    const { getByTestId } = render(<Harness />);

    const event = pressSelectAll(getByTestId("panel-root"));

    // preventDefault is the half that suppresses Electron's native accelerator:
    // AppKit never sees a key the page already handled.
    expect(event.defaultPrevented).toBe(true);
    const range = window.getSelection()?.getRangeAt(0);
    expect(range?.commonAncestorContainer).toBe(getByTestId("body"));
    expect(selectedText()).toContain("document text");
    expect(selectedText()).not.toContain("Refresh");
  });

  it("also claims the chord when focus is inside the region", () => {
    const { getByTestId } = render(<Harness />);

    const event = pressSelectAll(getByTestId("doc-link"));

    expect(event.defaultPrevented).toBe(true);
    expect(window.getSelection()?.getRangeAt(0).commonAncestorContainer).toBe(getByTestId("body"));
  });

  it("treats Ctrl+A the same way, for Windows and Linux", () => {
    const { getByTestId } = render(<Harness />);

    const event = pressSelectAll(getByTestId("panel-root"), { metaKey: false, ctrlKey: true });

    expect(event.defaultPrevented).toBe(true);
    expect(selectedText()).toContain("document text");
  });

  it("leaves Cmd+A in a text field alone", () => {
    const { getByTestId } = render(<Harness />);

    const event = pressSelectAll(getByTestId("search"));

    expect(event.defaultPrevented).toBe(false);
    expect(window.getSelection()?.rangeCount ?? 0).toBe(0);
  });

  it("leaves an event a higher-priority owner already claimed alone", () => {
    const { getByTestId } = render(<Harness />);
    const root = getByTestId("panel-root");
    // An explicit keybinding or an inner editor handled the chord first.
    root.addEventListener("keydown", (e) => e.preventDefault(), { once: true });

    pressSelectAll(root);

    expect(window.getSelection()?.rangeCount ?? 0).toBe(0);
  });

  it("ignores the chord when nothing holds focus", () => {
    render(<Harness />);

    // body is the keydown target when no element is focused, and it contains
    // every mounted region — treating it as ownership would let them all fire.
    const event = pressSelectAll(document.body);

    expect(event.defaultPrevented).toBe(false);
    expect(window.getSelection()?.rangeCount ?? 0).toBe(0);
  });

  it("ignores modified variants that are not Select All", () => {
    const { getByTestId } = render(<Harness />);
    const root = getByTestId("panel-root");

    expect(pressSelectAll(root, { shiftKey: true }).defaultPrevented).toBe(false);
    expect(pressSelectAll(root, { altKey: true }).defaultPrevented).toBe(false);
    expect(pressSelectAll(root, { metaKey: false }).defaultPrevented).toBe(false);
    expect(pressSelectAll(root, { key: "b" }).defaultPrevented).toBe(false);
    expect(window.getSelection()?.rangeCount ?? 0).toBe(0);
  });

  it("does nothing while disabled, and detaches on unmount", () => {
    const { getByTestId, rerender, unmount } = render(<Harness enabled={false} />);
    const root = getByTestId("panel-root");

    expect(pressSelectAll(root).defaultPrevented).toBe(false);

    rerender(<Harness enabled={true} />);
    expect(pressSelectAll(root).defaultPrevented).toBe(true);

    const detached = getByTestId("panel-root");
    unmount();
    expect(pressSelectAll(detached).defaultPrevented).toBe(false);
  });

  it("lets only the region owning the keydown target act, with two mounted", () => {
    const first = render(<Harness bodyText="first document" />);
    const second = render(<Harness bodyText="second document" />);
    // RTL binds queries to document.body, which now holds both harnesses —
    // reach through each render's own container instead.
    const secondRoot = second.container.querySelector('[data-testid="panel-root"]');

    pressSelectAll(secondRoot!);

    // The gate is the event target, not a store flag, so the unfocused pane
    // stays inert even though its listener is live on the same document.
    expect(selectedText()).toContain("second document");
    expect(selectedText()).not.toContain("first document");

    first.unmount();
    second.unmount();
  });

  it("stays inert when focus is in an unrelated region", () => {
    render(<Harness />);
    const outsider = document.createElement("div");
    document.body.appendChild(outsider);

    const event = pressSelectAll(outsider);

    expect(event.defaultPrevented).toBe(false);
    expect(window.getSelection()?.rangeCount ?? 0).toBe(0);
    outsider.remove();
  });
});
