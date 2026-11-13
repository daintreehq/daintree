// @vitest-environment jsdom
import { createRef } from "react";
import { act, cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EditorView } from "@codemirror/view";
import { SearchQuery, searchPanelOpen, setSearchQuery } from "@codemirror/search";
import { CODE_VIEWER_OWNER_ATTR } from "@/lib/codeViewerKeys";
import { CodeViewer, type CodeViewerHandle } from "../CodeViewer";

const DOC = "alpha\nbeta alpha\ngamma\nalpha";

// CodeMirror resolves `Mod` from the platform it saw at import time.
function modKey(): KeyboardEventInit {
  return /Mac/.test(navigator.platform) ? { metaKey: true } : { ctrlKey: true };
}

function press(target: HTMLElement, init: KeyboardEventInit): KeyboardEvent {
  const event = new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init });
  target.dispatchEvent(event);
  return event;
}

function mountViewer() {
  const ref = createRef<CodeViewerHandle>();
  const utils = render(<CodeViewer ref={ref} content={DOC} filePath="notes.txt" />);
  const content = utils.container.querySelector<HTMLElement>(".cm-content")!;
  const view = EditorView.findFromDOM(utils.container.querySelector<HTMLElement>(".cm-editor")!)!;
  return { ref, content, view, container: utils.container };
}

function queryInput(container: HTMLElement): HTMLInputElement {
  return container.querySelector<HTMLInputElement>(".cm-search input[name=search]")!;
}

// jsdom treats any contenteditable attribute as focusable, "false" included.
// Chromium doesn't: a contenteditable="false" node with no tabindex refuses
// focus, which is what stranded focus on body.
beforeEach(() => {
  const realFocus = HTMLElement.prototype.focus;
  vi.spyOn(HTMLElement.prototype, "focus").mockImplementation(function (
    this: HTMLElement,
    options?: FocusOptions
  ) {
    if (this.getAttribute("contenteditable") === "false" && !this.hasAttribute("tabindex")) return;
    realFocus.call(this, options);
  });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("CodeViewer keyboard focus", () => {
  it("puts the read-only surface in the tab order without making it editable", () => {
    const { content, view } = mountViewer();
    expect(content.getAttribute("contenteditable")).toBe("false");
    expect(content.tabIndex).toBe(0);
    view.focus();
    expect(document.activeElement).toBe(content);
  });

  it("Escape in the find field closes it and returns focus to the viewer", () => {
    const { ref, content, view, container } = mountViewer();
    act(() => ref.current!.openSearch());
    expect(searchPanelOpen(view.state)).toBe(true);
    expect(document.activeElement).toBe(queryInput(container));

    press(queryInput(container), { key: "Escape", keyCode: 27 });

    expect(searchPanelOpen(view.state)).toBe(false);
    expect(document.activeElement).toBe(content);
  });

  it("the close button returns focus to the viewer", () => {
    const { ref, content, view, container } = mountViewer();
    act(() => ref.current!.openSearch());
    const close = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Close find bar"]'
    )!;
    close.focus();
    close.click();

    expect(searchPanelOpen(view.state)).toBe(false);
    expect(document.activeElement).toBe(content);
  });

  it("Mod-l opens go to line from the viewer and Escape returns focus to it", async () => {
    const { content, container } = mountViewer();
    content.focus();
    expect(document.activeElement).toBe(content);
    const event = press(content, { key: "l", keyCode: 76, ...modKey() });
    expect(event.defaultPrevented).toBe(true);
    const field = container.querySelector<HTMLInputElement>(".cm-goto-line input[name=line]");
    expect(field).not.toBeNull();
    // Chromium's select() focuses the field; jsdom's doesn't.
    field!.focus();
    expect(document.activeElement).toBe(field);

    press(field!, { key: "Escape", keyCode: 27 });
    expect(document.activeElement).toBe(content);
    await waitFor(() => expect(container.querySelector(".cm-goto-line")).toBeNull());
    expect(document.activeElement).toBe(content);
  });

  it("Mod-l opens go to line from the find field too", () => {
    const { ref, container } = mountViewer();
    act(() => ref.current!.openSearch());
    const event = press(queryInput(container), { key: "l", keyCode: 76, ...modKey() });
    expect(event.defaultPrevented).toBe(true);
    expect(container.querySelector(".cm-goto-line")).not.toBeNull();
  });

  it("marks one key owner around the content and the find bar", () => {
    const { ref, content, container } = mountViewer();
    act(() => ref.current!.openSearch());
    const owner = content.closest(`[${CODE_VIEWER_OWNER_ATTR}]`);
    expect(owner).not.toBeNull();
    expect(owner!.contains(queryInput(container))).toBe(true);
  });

  it.each([
    ["F3", (shiftKey: boolean) => ({ key: "F3", keyCode: 114, shiftKey })],
    // A shifted letter reports its capital, as a real keyboard does.
    [
      "Mod-g",
      (shiftKey: boolean) => ({ key: shiftKey ? "G" : "g", keyCode: 71, shiftKey, ...modKey() }),
    ],
  ])("Mod-f from the viewer opens find, and %s steps through matches from it", (_name, step) => {
    const { content, view, container } = mountViewer();
    content.focus();
    expect(document.activeElement).toBe(content);
    press(content, { key: "f", keyCode: 70, ...modKey() });
    expect(searchPanelOpen(view.state)).toBe(true);

    act(() => {
      view.dispatch({ effects: setSearchQuery.of(new SearchQuery({ search: "alpha" })) });
    });
    act(() => {
      press(queryInput(container), { key: "Escape", keyCode: 27 });
    });
    expect(document.activeElement).toBe(content);

    const matches = [...DOC.matchAll(/alpha/g)].map((m) => m.index);
    const next = press(content, step(false));
    expect(next.defaultPrevented).toBe(true);
    expect(view.state.selection.main.from).toBe(matches[0]);
    press(content, step(false));
    expect(view.state.selection.main.from).toBe(matches[1]);
    press(content, step(true));
    expect(view.state.selection.main.from).toBe(matches[0]);
  });
});
