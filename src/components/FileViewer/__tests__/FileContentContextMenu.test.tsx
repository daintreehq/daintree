// @vitest-environment jsdom
import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { ReactNode } from "react";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import {
  FileContentContextMenu,
  hasTextSelectionWithin,
  isEditableMenuTarget,
} from "../FileContentContextMenu";

/** Stands in for the panel menu every pane sits inside. */
function PanelMenu({ children }: { children: ReactNode }) {
  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <div data-testid="panel">{children}</div>
      </ContextMenuTrigger>
      <ContextMenuContent>
        <ContextMenuItem>Panel item</ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}

function renderContent(items: ReactNode = <ContextMenuItem>Reveal file</ContextMenuItem>) {
  render(
    <PanelMenu>
      <FileContentContextMenu items={items}>
        <div data-testid="body">
          <p data-testid="text">const answer = 42;</p>
          <textarea data-testid="editor" defaultValue="draft" />
        </div>
      </FileContentContextMenu>
      <p data-testid="elsewhere">another pane&apos;s text</p>
    </PanelMenu>
  );
}

function selectContents(node: Node) {
  const range = document.createRange();
  range.selectNodeContents(node);
  const selection = window.getSelection()!;
  selection.removeAllRanges();
  selection.addRange(range);
}

/** Dispatches a right-click and reports whether anything prevented its default. */
function rightClick(target: Element): boolean {
  const event = new MouseEvent("contextmenu", { bubbles: true, cancelable: true, button: 2 });
  act(() => {
    target.dispatchEvent(event);
  });
  return event.defaultPrevented;
}

afterEach(() => {
  window.getSelection()?.removeAllRanges();
});

describe("FileContentContextMenu", () => {
  it("opens the file's menu instead of the panel's", async () => {
    renderContent();

    expect(rightClick(screen.getByTestId("text"))).toBe(true);

    expect(await screen.findByText("Reveal file")).toBeTruthy();
    expect(screen.queryByText("Panel item")).toBeNull();
  });

  it("leaves a right-click on selected text to the native edit menu", () => {
    renderContent();
    selectContents(screen.getByTestId("text"));

    // Not prevented: that is what lets Electron raise its own Copy menu.
    expect(rightClick(screen.getByTestId("text"))).toBe(false);

    expect(screen.queryByText("Reveal file")).toBeNull();
    expect(screen.queryByText("Panel item")).toBeNull();
  });

  it("leaves a right-click on an editable target to the native edit menu", () => {
    renderContent();

    expect(rightClick(screen.getByTestId("editor"))).toBe(false);

    expect(screen.queryByText("Reveal file")).toBeNull();
    expect(screen.queryByText("Panel item")).toBeNull();
  });

  it("decides on the selection as it stood at the press, not after it", async () => {
    // macOS selects the word under the pointer during the right-button press,
    // so a right-click on unselected text arrives looking like a selection.
    renderContent();
    const text = screen.getByTestId("text");

    fireEvent.pointerDown(text, { button: 2 });
    selectContents(text);
    rightClick(text);

    expect(await screen.findByText("Reveal file")).toBeTruthy();
  });

  it("ignores a selection standing in another region", async () => {
    renderContent();
    selectContents(screen.getByTestId("elsewhere"));

    rightClick(screen.getByTestId("text"));

    expect(await screen.findByText("Reveal file")).toBeTruthy();
  });

  it("opens the file's menu from the keyboard instead of the panel's", async () => {
    renderContent();
    const body = screen.getByTestId("body");

    // The marker is what stands the global panel-menu key handler down.
    expect(body.hasAttribute("data-row-menu")).toBe(true);
    act(() => {
      fireEvent.keyDown(screen.getByTestId("text"), { key: "F10", shiftKey: true });
    });

    expect(await screen.findByText("Reveal file")).toBeTruthy();
    expect(screen.queryByText("Panel item")).toBeNull();
  });

  it("leaves the menu key to the browser while text is selected", () => {
    renderContent();
    selectContents(screen.getByTestId("text"));

    const notPrevented = fireEvent.keyDown(screen.getByTestId("text"), { key: "ContextMenu" });

    // Not prevented, so Chromium raises its own contextmenu and the native
    // edit menu answers it, as for a right-click.
    expect(notPrevented).toBe(true);
    expect(screen.queryByText("Reveal file")).toBeNull();
  });

  it("drops a press's selection snapshot once the keyboard takes over", () => {
    renderContent();
    const text = screen.getByTestId("text");

    // A right-press with nothing selected that never produced a menu…
    fireEvent.pointerDown(text, { button: 2 });
    // …then a keyboard selection and a keyboard-raised menu.
    selectContents(text);
    fireEvent.keyDown(text, { key: "Shift" });
    rightClick(text);

    expect(screen.queryByText("Reveal file")).toBeNull();
  });

  it("stands down with no file, so the enclosing menu opens", async () => {
    renderContent(null);

    expect(screen.getByTestId("body").hasAttribute("data-row-menu")).toBe(false);
    rightClick(screen.getByTestId("text"));

    expect(await screen.findByText("Panel item")).toBeTruthy();
  });
});

describe("isEditableMenuTarget", () => {
  it("recognises text inputs and contenteditable, and nothing else", () => {
    const root = document.createElement("div");
    root.innerHTML = `<input /><div contenteditable="true"><span>in</span></div><span id="plain">plain</span>`;
    document.body.append(root);
    try {
      expect(isEditableMenuTarget(root.querySelector("input"))).toBe(true);
      // jsdom has no `isContentEditable`; the attribute is what it would read.
      const editable = root.querySelector<HTMLElement>("[contenteditable] span");
      if (!editable) throw new Error("fixture lost its editable span");
      Object.defineProperty(editable, "isContentEditable", { value: true });
      expect(isEditableMenuTarget(editable)).toBe(true);
      expect(isEditableMenuTarget(root.querySelector("#plain"))).toBe(false);
      expect(isEditableMenuTarget(null)).toBe(false);
    } finally {
      root.remove();
    }
  });
});

describe("hasTextSelectionWithin", () => {
  it("is false for a collapsed selection", () => {
    const region = document.createElement("div");
    region.textContent = "text";
    document.body.append(region);
    try {
      window.getSelection()!.collapse(region.firstChild!, 1);
      expect(hasTextSelectionWithin(region)).toBe(false);
      selectContents(region);
      expect(hasTextSelectionWithin(region)).toBe(true);
    } finally {
      region.remove();
    }
  });
});
