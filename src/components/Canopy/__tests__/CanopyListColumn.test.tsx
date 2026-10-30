// @vitest-environment jsdom
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { useCanopyStore } from "@/store/canopyStore";
import { CanopyListColumn } from "../CanopyListColumn";
import {
  CANOPY_LIST_MAX_WIDTH,
  CANOPY_LIST_MIN_WIDTH,
  CANOPY_PANE_MIN_WIDTH,
  canopyListRoom,
} from "../canopyListWidth";

const KEY = "daintree-canopy-list-width";

/** What layout would report: jsdom lays nothing out, so each test sets the widths. */
const layout = { column: 448, split: 1400 };

/** The column's observers, so a test can tell it layout moved. */
const observers = new Set<() => void>();
const relayout = () => act(() => observers.forEach((notify) => notify()));

const realResizeObserver = globalThis.ResizeObserver;
beforeAll(() => {
  globalThis.ResizeObserver = class {
    private readonly notify: () => void;
    constructor(callback: ResizeObserverCallback) {
      this.notify = () => callback([], this as unknown as ResizeObserver);
    }
    observe() {
      observers.add(this.notify);
    }
    unobserve() {}
    disconnect() {
      observers.delete(this.notify);
    }
  } as unknown as typeof ResizeObserver;
});
afterAll(() => {
  globalThis.ResizeObserver = realResizeObserver;
});

beforeEach(() => {
  layout.column = 448;
  layout.split = 1400;
  vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(function (this: Element) {
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

const storageWrites = () => vi.spyOn(Storage.prototype, "setItem");

const ariaRange = (handle: HTMLElement) =>
  ["aria-valuemin", "aria-valuenow", "aria-valuemax"].map((name) =>
    Number(handle.getAttribute(name))
  );

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

  it("writes nothing for a press that never moved off a width already kept", () => {
    act(() => useCanopyStore.getState().setListWidth(600));
    layout.column = 600;
    const { handle } = mount();
    const writes = storageWrites();
    fireEvent.mouseDown(handle, { button: 0, clientX: 600 });
    fireEvent.mouseUp(document);
    expect(writes).not.toHaveBeenCalled();
    expect(useCanopyStore.getState().listWidth).toBe(600);
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
    act(() => useCanopyStore.getState().setListWidth(900));
    layout.split = 1000;
    layout.column = 1000 - CANOPY_PANE_MIN_WIDTH;
    const { handle } = mount();
    expect(handle.getAttribute("aria-valuenow")).toBe(String(layout.column));

    // Into the cap and back to it: nothing on screen moved, so nothing is written.
    const writes = storageWrites();
    fireEvent.mouseDown(handle, { button: 0, clientX: layout.column });
    fireEvent.mouseMove(document, { clientX: layout.column + 200 });
    fireEvent.mouseUp(document);
    fireEvent.keyDown(handle, { key: "End" });
    expect(writes).not.toHaveBeenCalled();
    expect(useCanopyStore.getState().listWidth).toBe(900);

    // A step in from the edge shown is a step, not 260px of nothing.
    fireEvent.keyDown(handle, { key: "ArrowLeft" });
    expect(useCanopyStore.getState().listWidth).toBe(layout.column - 10);
  });

  it("can't be moved in a window too narrow for both minimums, and says so in its range", () => {
    layout.split = 500;
    layout.column = 250;
    const { handle } = mount();
    const [min, now, max] = ariaRange(handle);
    expect(min).toBeLessThanOrEqual(now);
    expect(now).toBeLessThanOrEqual(max);

    fireEvent.mouseDown(handle, { button: 0, clientX: 250 });
    expect(useCanopyStore.getState().listDrag).toBeNull();
    fireEvent.mouseMove(document, { clientX: 400 });
    fireEvent.mouseUp(document);
    fireEvent.keyDown(handle, { key: "ArrowRight" });
    fireEvent.keyDown(handle, { key: "Home" });
    expect(useCanopyStore.getState().listWidth).toBeNull();
  });

  it("steps from the width on screen, and resets on Enter or a double-click", () => {
    const { handle } = mount();
    fireEvent.keyDown(handle, { key: "ArrowRight" });
    expect(useCanopyStore.getState().listWidth).toBe(458);
    layout.column = 458;
    relayout();
    expect(handle.getAttribute("aria-valuenow")).toBe("458");
    fireEvent.keyDown(handle, { key: "ArrowLeft", shiftKey: true });
    expect(useCanopyStore.getState().listWidth).toBe(408);
    fireEvent.keyDown(handle, { key: "Home" });
    expect(useCanopyStore.getState().listWidth).toBe(CANOPY_LIST_MIN_WIDTH);
    fireEvent.keyDown(handle, { key: "Enter" });
    expect(useCanopyStore.getState().listWidth).toBeNull();

    act(() => useCanopyStore.getState().setListWidth(700));
    fireEvent.doubleClick(handle);
    expect(useCanopyStore.getState().listWidth).toBeNull();
    expect(window.localStorage.getItem(KEY)).toBeNull();
  });

  it("lands where this drag left it, whatever a sibling view set meanwhile", () => {
    act(() => useCanopyStore.getState().setListWidth(600));
    layout.column = 600;
    const { container, handle } = mount();
    fireEvent.mouseDown(handle, { button: 0, clientX: 600 });
    fireEvent.mouseMove(document, { clientX: 650 });
    act(() => {
      window.localStorage.setItem(KEY, "700");
      window.dispatchEvent(new StorageEvent("storage", { key: KEY }));
    });
    // The drag still shows its own width over the sibling's.
    expect(listVar(container)).toBe("650px");
    fireEvent.mouseMove(document, { clientX: 600 });
    fireEvent.mouseUp(document);
    expect(useCanopyStore.getState().listWidth).toBe(600);
    expect(window.localStorage.getItem(KEY)).toBe("600");
    expect(listVar(container)).toBe("600px");
  });

  it("lands the drag when the window loses focus, and puts the page's own styles back", () => {
    document.body.style.cursor = "wait";
    document.body.style.userSelect = "text";
    const { container, handle } = mount();
    fireEvent.mouseDown(handle, { button: 0, clientX: 448 });
    fireEvent.mouseMove(document, { clientX: 500 });
    fireEvent.blur(window);
    expect(useCanopyStore.getState().listDrag).toBeNull();
    expect(useCanopyStore.getState().listWidth).toBe(500);
    expect(document.body.style.cursor).toBe("wait");
    expect(document.body.style.userSelect).toBe("text");

    // The listeners went with it: a stray move starts nothing.
    fireEvent.mouseMove(document, { clientX: 700 });
    expect(useCanopyStore.getState().listDrag).toBeNull();
    expect(listVar(container)).toBe("500px");
  });

  it("lands the drag once, and lets the terminal go, when the list leaves mid-drag", () => {
    const { handle, unmount } = mount();
    fireEvent.mouseDown(handle, { button: 0, clientX: 448 });
    fireEvent.mouseMove(document, { clientX: 520 });
    const writes = storageWrites();
    unmount();
    expect(useCanopyStore.getState().listDrag).toBeNull();
    expect(useCanopyStore.getState().listWidth).toBe(520);
    expect(document.body.style.cursor).toBe("");

    fireEvent.mouseMove(document, { clientX: 700 });
    fireEvent.mouseUp(document);
    fireEvent.blur(window);
    expect(writes).toHaveBeenCalledTimes(1);
    expect(useCanopyStore.getState().listDrag).toBeNull();
    expect(useCanopyStore.getState().listWidth).toBe(520);
  });
});

describe("canopyListRoom", () => {
  it("leaves the pane its minimum in a split that holds both", () => {
    expect(1400 - canopyListRoom(1400)).toBe(CANOPY_PANE_MIN_WIDTH);
    expect(canopyListRoom(1400)).toBeGreaterThan(CANOPY_LIST_MIN_WIDTH);
  });

  it("splits evenly rather than leave the list the narrower", () => {
    expect(canopyListRoom(500)).toBe(250);
  });

  it("narrows nothing before the split is measured", () => {
    expect(canopyListRoom(0)).toBe(CANOPY_LIST_MAX_WIDTH);
  });
});
