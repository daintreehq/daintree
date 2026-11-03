// @vitest-environment jsdom
import { act, fireEvent, render } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { useCanopyStore } from "@/store/canopyStore";
import { CanopyDetailSplit } from "../CanopyDetailSplit";
import { CANOPY_DOCK_MIN_WIDTH, CANOPY_DOCK_SIDE_BY_SIDE_MIN } from "../canopyDockWidth";

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

/** The widths the layout measures: the split's own, and the docked pane's. */
let widths = { split: 1200, dock: 480 };

beforeEach(() => {
  widths = { split: 1200, dock: 480 };
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (
    this: HTMLElement
  ) {
    const width = this.hasAttribute("data-canopy-global")
      ? widths.dock
      : this.hasAttribute("data-canopy-detail-split")
        ? widths.split
        : 0;
    return { width, height: 600, top: 0, left: 0, right: width, bottom: 600 } as DOMRect;
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  useCanopyStore.setState({ dockWidth: null, dockDrag: null });
  window.localStorage.removeItem("daintree-canopy-dock-width");
});

const split = () => document.querySelector<HTMLElement>("[data-canopy-detail-split]");
const edge = () => document.querySelector<HTMLElement>("[data-testid=canopy-dock-resize]");

function renderPair() {
  return render(
    <CanopyDetailSplit dock={<div data-testid="assistant" />}>
      <div data-testid="agent" />
    </CanopyDetailSplit>
  );
}

describe("CanopyDetailSplit (#16214)", () => {
  it("sits the agent and the assistant side by side, the assistant's edge between them", () => {
    renderPair();
    expect(split()!.getAttribute("data-canopy-detail-split")).toBe("side-by-side");
    const order = [...split()!.children].map(
      (child) =>
        child.getAttribute("data-testid") ?? child.firstElementChild?.getAttribute("data-testid")
    );
    expect(order).toEqual(["agent", "canopy-dock-resize", "assistant"]);
  });

  it("stacks them, with no edge to drag, where there isn't room for both", () => {
    widths.split = CANOPY_DOCK_SIDE_BY_SIDE_MIN - 1;
    renderPair();
    expect(split()!.getAttribute("data-canopy-detail-split")).toBe("stacked");
    expect(edge()).toBeNull();
  });

  it("gives either one the whole area alone", () => {
    const { rerender } = render(
      <CanopyDetailSplit dock={null}>{<div data-testid="agent" />}</CanopyDetailSplit>
    );
    expect(split()).toBeNull();
    expect(edge()).toBeNull();
    rerender(<CanopyDetailSplit dock={<div data-testid="assistant" />}>{null}</CanopyDetailSplit>);
    expect(split()).toBeNull();
    expect(document.querySelector("[data-testid=assistant]")).not.toBeNull();
  });

  it("widens the assistant leftward from the keyboard, and resets on a double-click", () => {
    renderPair();
    fireEvent.keyDown(edge()!, { key: "ArrowLeft" });
    expect(useCanopyStore.getState().dockWidth).toBe(widths.dock + 10);
    fireEvent.keyDown(edge()!, { key: "ArrowRight", shiftKey: true });
    expect(useCanopyStore.getState().dockWidth).toBe(widths.dock - 50);
    fireEvent.doubleClick(edge()!);
    expect(useCanopyStore.getState().dockWidth).toBeNull();
  });

  it("shows the width live while dragged and keeps it once the edge lands", () => {
    renderPair();
    fireEvent.mouseDown(edge()!, { button: 0, clientX: 700 });
    expect(useCanopyStore.getState().dockDrag).toBe(widths.dock);
    fireEvent.mouseMove(document, { clientX: 600 });
    expect(useCanopyStore.getState().dockDrag).toBe(widths.dock + 100);
    expect(
      split()!
        .querySelector<HTMLElement>("[data-canopy-global]")!
        .style.getPropertyValue("--canopy-dock-width")
    ).toBe(`${widths.dock + 100}px`);
    fireEvent.mouseUp(document);
    expect(useCanopyStore.getState().dockDrag).toBeNull();
    expect(useCanopyStore.getState().dockWidth).toBe(widths.dock + 100);
  });

  it("never drags the assistant narrower than its minimum", () => {
    renderPair();
    fireEvent.mouseDown(edge()!, { button: 0, clientX: 700 });
    fireEvent.mouseMove(document, { clientX: 2000 });
    fireEvent.mouseUp(document);
    expect(useCanopyStore.getState().dockWidth).toBe(CANOPY_DOCK_MIN_WIDTH);
  });

  it("lands a drag under way when the dock goes, so the terminals' hold lifts", () => {
    const { rerender } = renderPair();
    fireEvent.mouseDown(edge()!, { button: 0, clientX: 700 });
    fireEvent.mouseMove(document, { clientX: 650 });
    expect(useCanopyStore.getState().dockDrag).not.toBeNull();
    act(() => {
      rerender(<CanopyDetailSplit dock={null}>{<div data-testid="agent" />}</CanopyDetailSplit>);
    });
    expect(useCanopyStore.getState().dockDrag).toBeNull();
    expect(document.body.style.cursor).toBe("");
  });
});
