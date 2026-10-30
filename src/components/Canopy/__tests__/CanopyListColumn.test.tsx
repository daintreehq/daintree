// @vitest-environment jsdom
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { useCanopyStore } from "@/store/canopyStore";
import { CanopyListColumn } from "../CanopyListColumn";
import { CANOPY_LIST_MIN_WIDTH, CANOPY_PANE_MIN_WIDTH } from "../canopyListWidth";

const KEY = "daintree-canopy-list-width";

/** What layout would report: jsdom lays nothing out, so each test sets the widths. */
const layout = { column: 448, split: 1400 };

beforeAll(() => {
  if (typeof globalThis.ResizeObserver === "undefined") {
    globalThis.ResizeObserver = class {
      observe() {}
      unobserve() {}
      disconnect() {}
    } as unknown as typeof ResizeObserver;
  }
});

beforeEach(() => {
  layout.column = 448;
  layout.split = 1400;
  vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(function (
    this: Element
  ) {
    const width = this.classList.contains("canopy-list-column")
      ? layout.column
      : this.hasAttribute("data-split")
        ? layout.split
        : 0;
    return { width, height: 600, top: 0, left: 0, right: width, bottom: 600 } as DOMRect;
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  window.localStorage.removeItem(KEY);
  useCanopyStore.setState({ listWidth: null, listDrag: null });
  document.body.style.cursor = "";
  document.body.style.userSelect = "";
});

function mount() {
  const view = render(
    <div data-split="">
      <CanopyListColumn>
        <p>Rows</p>
      </CanopyListColumn>
    </div>
  );
  return { ...view, handle: screen.getByTestId("canopy-list-resize") };
}

const listVar = (container: HTMLElement) =>
  container
    .querySelector<HTMLElement>(".canopy-list-column")!
    .style.getPropertyValue("--canopy-list-width");

describe("CanopyListColumn", () => {
  it("follows the pointer while dragged, and keeps the width only once it lands", () => {
    const { container, handle } = mount();
    fireEvent.mouseDown(handle, { button: 0, clientX: 448 });
    fireEvent.mouseMove(document, { clientX: 548 });
    expect(listVar(container)).toBe("548px");
    expect(useCanopyStore.getState().listWidth).toBeNull();
    expect(window.localStorage.getItem(KEY)).toBeNull();
    expect(document.body.style.cursor).toBe("col-resize");

    fireEvent.mouseUp(document);
    expect(useCanopyStore.getState().listDrag).toBeNull();
    expect(useCanopyStore.getState().listWidth).toBe(548);
    expect(window.localStorage.getItem(KEY)).toBe("548");
    expect(listVar(container)).toBe("548px");
    expect(document.body.style.cursor).toBe("");
  });

  it("leaves the default as the default when pressed without moving", () => {
    const { container, handle } = mount();
    fireEvent.mouseDown(handle, { button: 0, clientX: 448 });
    fireEvent.mouseUp(document);
    expect(useCanopyStore.getState().listWidth).toBeNull();
    expect(window.localStorage.getItem(KEY)).toBeNull();
    expect(listVar(container)).toBe("");
  });

  it("stops where the pane would drop below its minimum", () => {
    layout.split = 1000;
    const { handle } = mount();
    fireEvent.mouseDown(handle, { button: 0, clientX: 448 });
    fireEvent.mouseMove(document, { clientX: 1200 });
    fireEvent.mouseUp(document);
    expect(useCanopyStore.getState().listWidth).toBe(1000 - CANOPY_PANE_MIN_WIDTH);
  });

  it("keeps a wider width a narrow window can't show, and reads from the width shown", () => {
    useCanopyStore.setState({ listWidth: 900 });
    layout.split = 1000;
    layout.column = 1000 - CANOPY_PANE_MIN_WIDTH;
    const { handle } = mount();
    expect(handle.getAttribute("aria-valuenow")).toBe(String(layout.column));

    // Into the cap and back to it: nothing on screen moved, so neither does the width kept.
    fireEvent.mouseDown(handle, { button: 0, clientX: layout.column });
    fireEvent.mouseMove(document, { clientX: layout.column + 200 });
    fireEvent.mouseUp(document);
    expect(useCanopyStore.getState().listWidth).toBe(900);
    fireEvent.keyDown(handle, { key: "End" });
    expect(useCanopyStore.getState().listWidth).toBe(900);

    // A step in from the edge shown is a step, not 290px of nothing.
    fireEvent.keyDown(handle, { key: "ArrowLeft" });
    expect(useCanopyStore.getState().listWidth).toBe(layout.column - 10);
  });

  it("steps from the keyboard, and resets on Enter or a double-click", () => {
    const { handle } = mount();
    fireEvent.keyDown(handle, { key: "ArrowRight" });
    expect(useCanopyStore.getState().listWidth).toBe(458);
    fireEvent.keyDown(handle, { key: "ArrowLeft", shiftKey: true });
    expect(useCanopyStore.getState().listWidth).toBe(398);
    fireEvent.keyDown(handle, { key: "Home" });
    expect(useCanopyStore.getState().listWidth).toBe(CANOPY_LIST_MIN_WIDTH);
    fireEvent.keyDown(handle, { key: "Enter" });
    expect(useCanopyStore.getState().listWidth).toBeNull();

    act(() => useCanopyStore.getState().setListWidth(700));
    fireEvent.doubleClick(handle);
    expect(useCanopyStore.getState().listWidth).toBeNull();
    expect(window.localStorage.getItem(KEY)).toBeNull();
  });

  it("lands the drag when the window loses focus mid-drag", () => {
    const { handle } = mount();
    fireEvent.mouseDown(handle, { button: 0, clientX: 448 });
    fireEvent.mouseMove(document, { clientX: 500 });
    fireEvent.blur(window);
    expect(useCanopyStore.getState().listDrag).toBeNull();
    expect(useCanopyStore.getState().listWidth).toBe(500);
    expect(document.body.style.userSelect).toBe("");

    // The listeners went with it.
    fireEvent.mouseMove(document, { clientX: 700 });
    expect(useCanopyStore.getState().listWidth).toBe(500);
  });

  it("lets the terminal go when the list leaves mid-drag", () => {
    const { handle, unmount } = mount();
    fireEvent.mouseDown(handle, { button: 0, clientX: 448 });
    expect(useCanopyStore.getState().listDrag).not.toBeNull();
    unmount();
    expect(useCanopyStore.getState().listDrag).toBeNull();
    expect(document.body.style.cursor).toBe("");
  });
});
